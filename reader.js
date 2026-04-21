(async function () {
  // ── State ──
  let words = [];
  let paragraphStarts = []; // indices into words[] where paragraphs begin
  let currentIndex = 0;
  let playing = false;
  let timer = null;
  let settings = {};
  let rampWordsRemaining = 0; // countdown for ramp-up after unpause
  let progressAnimFrame = null; // for smooth progress bar
  let parenStack = [];          // stack of open paren/bracket/brace characters
  let paragraphTypes = [];      // "heading-N", "paragraph", "blockquote", "list-ul", "list-ol", "hr" per paragraph
  let headings = [];            // { paraIndex, wordIndex, level, text } for ToC
  let wordFormats = [];         // { bold, italic, code, strike } per word
  let imageAtWord = {};         // wordIndex → { src, alt } for image placeholders
  let hyphenContinuation = [];  // true if word is a continuation of a hyphen-split compound
  let pausedAtTime = 0;        // timestamp of last pause (for dynamic ramp-up)
  let currentRampFraction = 0.5; // dynamically set on each resume

  // Target speed ramp (logistic S-curve)
  let targetRampActive = false;   // toggled with W key
  let targetRampStartWpm = 0;     // WPM when ramp started/resumed
  let targetRampWordsPlayed = 0;  // words played since ramp (re)started
  let targetRampTotalWords = 0;   // total words over which to ramp

  // ── Load ──
  settings = await loadSettings();
  applyTheme();

  const text = sessionStorage.getItem("novaReaderText") || "";
  const blocks = JSON.parse(sessionStorage.getItem("novaReaderBlocks") || "null");

  if (!text) {
    document.getElementById("start-overlay").querySelector("h2").textContent =
      "No text loaded";
    return;
  }

  parseText(text, blocks);
  document.getElementById("word-count-info").textContent =
    `${words.length} words \u2022 ~${Math.round(words.length / (settings.wpm || 300))} min at ${settings.wpm} WPM`;

  // ── UI refs ──
  const wordBefore = document.getElementById("word-before");
  const wordOrp = document.getElementById("word-orp");
  const wordAfter = document.getElementById("word-after");
  const focusLineTop = document.getElementById("focus-line-top");
  const focusLineBottom = document.getElementById("focus-line-bottom");
  const wordContainer = document.getElementById("word-container");
  const wpmDisplay = document.getElementById("wpm-display");
  const wordCounter = document.getElementById("word-counter");
  const progressBar = document.getElementById("progress-bar");
  const pauseIndicator = document.getElementById("pause-indicator");
  const contextBefore = document.getElementById("context-before");
  const contextAfter = document.getElementById("context-after");
  const startOverlay = document.getElementById("start-overlay");
  const btnPause = document.getElementById("btn-pause");
  const tocOverlay = document.getElementById("toc-overlay");
  const tocList = document.getElementById("toc-list");
  const imageOverlay = document.getElementById("image-overlay");
  const imageDisplay = document.getElementById("image-display");
  const imageCaption = document.getElementById("image-caption");

  updateWpmDisplay();

  // ── Text parsing ──
  // Emit an image placeholder at the current word position.
  function emitImage(src, alt) {
    paragraphStarts.push(words.length);
    paragraphTypes.push("image");
    imageAtWord[words.length] = { src, alt: alt || "" };
    words.push("\u{1F5BC}"); // 🖼 placeholder
    wordFormats.push({ bold: false, italic: false, code: false, strike: false, link: null });
    hyphenContinuation.push(false);
  }

  // Emit a text block, splitting on inline ![alt](url) markdown so images
  // become their own block (image overlay) rather than being flattened to
  // plain alt text inside a paragraph.
  function emitBlockFromText(text, type) {
    const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const segments = [];
    let lastIdx = 0;
    let m;
    while ((m = IMG_RE.exec(text)) !== null) {
      if (m.index > lastIdx) segments.push({ kind: "text", text: text.slice(lastIdx, m.index) });
      const src = m[2].trim();
      if (src && !src.startsWith("javascript:")) {
        segments.push({ kind: "image", src, alt: m[1] });
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) segments.push({ kind: "text", text: text.slice(lastIdx) });
    if (segments.length === 0) segments.push({ kind: "text", text });

    for (const seg of segments) {
      if (seg.kind === "image") { emitImage(seg.src, seg.alt); continue; }
      const trimmed = seg.text.trim();
      if (!trimmed) continue;
      paragraphStarts.push(words.length);
      paragraphTypes.push(type);
      const hMatch = type.match(/^heading-(\d)$/);
      if (hMatch) {
        headings.push({
          paraIndex: paragraphStarts.length - 1,
          wordIndex: words.length,
          level: parseInt(hMatch[1]),
          text: trimmed,
        });
      }
      const { tokens, formats, continuations } = tokenizeMarkdown(trimmed);
      words.push(...tokens);
      wordFormats.push(...formats);
      hyphenContinuation.push(...continuations);
    }
  }

  function parseText(raw, structuredBlocks) {
    words = [];
    paragraphStarts = [];
    paragraphTypes = [];
    headings = [];
    wordFormats = [];
    hyphenContinuation = [];

    imageAtWord = {};

    if (structuredBlocks && structuredBlocks.length > 0) {
      // Use structured block data from page extraction
      for (const block of structuredBlocks) {
        if (block.type === "image") {
          emitImage(block.src, block.alt);
          continue;
        }
        const trimmed = block.text.trim();
        if (!trimmed) continue;
        const type = block.type === "heading" ? "heading-" + block.level : "paragraph";
        emitBlockFromText(trimmed, type);
      }
    } else {
      // Plain text / markdown — split into lines, group into paragraphs
      const lines = raw.split(/\n/);
      let group = [];

      const flushGroup = () => {
        if (group.length === 0) return;
        const text = group.join(" ").trim();
        if (!text) { group = []; return; }
        const isHead = isLikelyHeading(text);
        emitBlockFromText(text, isHead ? "heading-2" : "paragraph");
        group = [];
      };

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();

        // Blank line → flush
        if (!line.trim()) { flushGroup(); continue; }

        // Horizontal rule
        if (/^(\s*[-*_]\s*){3,}$/.test(line.trim())) {
          flushGroup();
          continue;
        }

        // Markdown heading
        const hMatch = line.match(/^(#{1,6})\s+(.*)/);
        if (hMatch) {
          flushGroup();
          const level = hMatch[1].length;
          const text = hMatch[2].replace(/\s+#+\s*$/, "").trim();
          if (!text) continue;
          emitBlockFromText(text, "heading-" + level);
          continue;
        }

        // Blockquote
        if (line.match(/^\s*>\s*/)) {
          flushGroup();
          const text = line.replace(/^\s*>\s*/, "").trim();
          if (!text) continue;
          emitBlockFromText(text, "blockquote");
          continue;
        }

        // Unordered list
        if (line.match(/^\s*[-*+]\s+/)) {
          flushGroup();
          const text = line.replace(/^\s*[-*+]\s+/, "").trim();
          if (!text) continue;
          emitBlockFromText(text, "list-ul");
          continue;
        }

        // Ordered list
        if (line.match(/^\s*\d+[.)]\s+/)) {
          flushGroup();
          const text = line.replace(/^\s*\d+[.)]\s+/, "").trim();
          if (!text) continue;
          emitBlockFromText(text, "list-ol");
          continue;
        }

        // Regular line — accumulate into group
        group.push(line.trim());
      }
      flushGroup();
    }
    // Sentinel: mark end as paragraph start for navigation
    paragraphStarts.push(words.length);
  }

  function isLikelyHeading(text) {
    const wordCount = text.split(/\s+/).length;
    if (wordCount > 8) return false;
    if (text.endsWith(".") || text.endsWith(",") || text.endsWith(";")) return false;
    if (/[a-zA-Z]/.test(text) && text === text.toUpperCase()) return true;
    return false;
  }

  // Tokenize text while stripping markdown inline formatting and tracking state
  function tokenizeMarkdown(text) {
    // Pre-pass: convert markdown link/image syntax while tracking per-char link URLs.
    // Images ![alt](url) reduce to plain alt text; links [text](url) keep their URL
    // in linkPerChar so the tokenizer can attach it to each word's format.
    let processed = "";
    const linkPerChar = [];
    let currentLink = null;
    {
      let k = 0;
      while (k < text.length) {
        const ch = text[k];
        if (ch === "[" || (ch === "!" && text[k + 1] === "[")) {
          const isImage = ch === "!";
          const textStart = isImage ? k + 2 : k + 1;
          const closeBracket = text.indexOf("]", textStart);
          if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
            const closeParen = text.indexOf(")", closeBracket + 2);
            if (closeParen !== -1) {
              const linkText = text.slice(textStart, closeBracket);
              const linkUrl = text.slice(closeBracket + 2, closeParen).trim();
              const useUrl = !isImage && linkUrl && !linkUrl.startsWith("javascript:") ? linkUrl : null;
              const wasLink = currentLink;
              if (useUrl) currentLink = useUrl;
              for (const lch of linkText) {
                processed += lch;
                linkPerChar.push(currentLink);
              }
              currentLink = wasLink;
              k = closeParen + 1;
              continue;
            }
          }
        }
        processed += ch;
        linkPerChar.push(currentLink);
        k++;
      }
    }

    // Build clean text and per-character format map
    let clean = "";
    const charFmt = [];
    let bold = false, italic = false, code = false, strike = false;
    let i = 0;

    while (i < processed.length) {
      if (processed[i] === "`") {
        code = !code; i++; continue;
      }
      if (code) {
        clean += processed[i];
        charFmt.push({ bold, italic, code: true, strike, link: linkPerChar[i] || null });
        i++; continue;
      }
      if (processed[i] === "~" && processed[i + 1] === "~") {
        strike = !strike; i += 2; continue;
      }
      if ((processed[i] === "*" && processed[i + 1] === "*") ||
          (processed[i] === "_" && processed[i + 1] === "_")) {
        bold = !bold; i += 2; continue;
      }
      if (processed[i] === "*") {
        italic = !italic; i++; continue;
      }
      if (processed[i] === "_") {
        const before = i > 0 ? processed[i - 1] : " ";
        const after = i + 1 < processed.length ? processed[i + 1] : " ";
        if (/\s/.test(before) || /\s/.test(after) || i === 0 || i === processed.length - 1) {
          italic = !italic; i++; continue;
        }
      }
      clean += processed[i];
      charFmt.push({ bold, italic, code, strike, link: linkPerChar[i] || null });
      i++;
    }

    // Tokenize clean text
    const tokens = [];
    const formats = [];
    const continuations = [];
    const HYPHEN_SPLIT_THRESHOLD = 14;
    const regex = /[$\u20AC\u00A3]?[\d]+(?:[,.][\d]+)*%?[.),:;!?]*|[^\s]+/g;
    let match;
    while ((match = regex.exec(clean)) !== null) {
      const tok = match[0];
      const fmt = charFmt[match.index] || { bold: false, italic: false, code: false, strike: false, link: null };
      if (tok.includes("\u2014") || tok.includes("\u2013")) {
        const parts = tok.split(/(\u2014|\u2013)/);
        for (const part of parts) {
          if (part) { tokens.push(part); formats.push(fmt); continuations.push(false); }
        }
      } else if (tok.length > HYPHEN_SPLIT_THRESHOLD && tok.includes("-") && /[a-zA-Z]/.test(tok) && !/^(https?:\/\/|www\.)/i.test(tok)) {
        const parts = tok.split(/(?<=-)/);
        let first = true;
        for (const part of parts) {
          if (part) {
            tokens.push(part);
            formats.push(fmt);
            continuations.push(!first);
            first = false;
          }
        }
      } else {
        tokens.push(tok);
        formats.push(fmt);
        continuations.push(false);
      }
    }

    // Shorten raw URLs so they fit the RSVP frame. A long URL can't be parsed
    // in one flash anyway, so collapse to "🔗 host…" and stash the full URL
    // in the format for the fulltext panel.
    const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;
    for (let j = 0; j < tokens.length; j++) {
      const tok = tokens[j];
      const fmt = formats[j];
      if (fmt && fmt.code) continue;
      if (tok.length < 22) continue;
      if (!URL_LIKE.test(tok)) continue;
      const tail = tok.match(/[.,;:!?)\]"']+$/);
      const bare = tail ? tok.slice(0, -tail[0].length) : tok;
      try {
        const asUrl = bare.startsWith("http") ? bare : "https://" + bare;
        const parsed = new URL(asUrl);
        const host = parsed.hostname.replace(/^www\./, "");
        const hasPath = parsed.pathname && parsed.pathname !== "/";
        tokens[j] = "\u{1F517} " + host + (hasPath ? "…" : "") + (tail ? tail[0] : "");
        if (!fmt.link) formats[j] = { ...fmt, link: asUrl };
      } catch {}
    }

    return { tokens, formats, continuations };
  }

  // ── ORP calculation ──
  function getOrpIndex(word) {
    const clean = word.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, "");
    const len = clean.length;
    if (len <= 1) return 0;
    if (len <= 3) return 1;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    if (len <= 13) return 3;
    return 4;
  }

  function getActualOrpIndex(word) {
    const orpInClean = getOrpIndex(word);
    let cleanCount = 0;
    for (let i = 0; i < word.length; i++) {
      if (/[a-zA-Z0-9\u00C0-\u024F]/.test(word[i])) {
        if (cleanCount === orpInClean) return i;
        cleanCount++;
      }
    }
    return Math.min(orpInClean, word.length - 1);
  }

  // ── Parenthetical tracking ──
  const OPEN_PARENS = { "(": ")", "[": "]", "{": "}" };
  const CLOSE_PARENS = { ")": "(", "]": "[", "}": "{" };

  function pushParenOpens(word) {
    for (const ch of word) {
      if (ch in OPEN_PARENS) parenStack.push(ch);
    }
  }

  function popParenCloses(word) {
    for (const ch of word) {
      if (ch in CLOSE_PARENS) {
        for (let i = parenStack.length - 1; i >= 0; i--) {
          if (parenStack[i] === CLOSE_PARENS[ch]) {
            parenStack.splice(i, 1);
            break;
          }
        }
      }
    }
  }

  function isDashToken(word) {
    return word === "\u2014" || word === "\u2013";
  }

  function rebuildParenStack(upToIndex) {
    parenStack = [];
    for (let i = 0; i <= upToIndex; i++) {
      if (isDashToken(words[i])) {
        const dashIdx = parenStack.indexOf("\u2013");
        if (dashIdx >= 0) parenStack.splice(dashIdx, 1);
        else parenStack.push("\u2013");
      }
      pushParenOpens(words[i]);
      popParenCloses(words[i]);
    }
  }

  function renderParenIndicator() {
    if (parenStack.length === 0) {
      parenIndicatorEl.textContent = "";
      parenIndicatorEl.style.opacity = "0";
      return;
    }
    parenIndicatorEl.textContent = parenStack.join(" ");
    parenIndicatorEl.style.opacity = "0.25";
  }

  // ── Display ──
  const headingIndicatorEl = document.getElementById("heading-indicator");
  const HEADING_WEIGHTS = { 1: "600", 2: "500", 3: "450", 4: "420", 5: "420", 6: "420" };

  function getParaForWord(index) {
    for (let p = paragraphStarts.length - 2; p >= 0; p--) {
      if (paragraphStarts[p] <= index) return p;
    }
    return 0;
  }

  function renderHeadingIndicator(index) {
    const p = getParaForWord(index);
    const type = paragraphTypes[p] || "paragraph";
    const hMatch = type.match(/^heading-(\d)$/);
    if (hMatch) {
      const level = parseInt(hMatch[1], 10);
      headingIndicatorEl.textContent = "#".repeat(level);
      headingIndicatorEl.style.opacity = "0.35";
      headingIndicatorEl.style.fontWeight = HEADING_WEIGHTS[level] || "420";
      const fmt = wordFormats[index];
      if (!(fmt && fmt.bold)) {
        wordDisplayEl.style.fontWeight = HEADING_WEIGHTS[level] || "420";
      }
    } else {
      headingIndicatorEl.textContent = "";
      headingIndicatorEl.style.opacity = "0";
    }
  }

  // Convert PUA sup/sub markers to HTML
  const HAS_SUP_SUB = /[\uE000-\uE003]/;
  function renderSupSub(str) {
    if (!HAS_SUP_SUB.test(str)) return null;
    let html = str
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\uE000/g, "<sup>").replace(/\uE001/g, "</sup>")
      .replace(/\uE002/g, "<sub>").replace(/\uE003/g, "</sub>");
    return html;
  }

  function stripMarkers(str) {
    return str.replace(/[\uE000-\uE003]/g, "");
  }

  function displayWord(index) {
    if (index < 0 || index >= words.length) return;
    currentIndex = index;
    const word = words[index];
    const cleanWord = stripMarkers(word);
    const orpIdx = getActualOrpIndex(cleanWord);

    let beforeStr, orpStr, afterStr;
    if (HAS_SUP_SUB.test(word)) {
      let cleanI = 0, splitBefore = 0, splitAfter = word.length;
      for (let j = 0; j < word.length; j++) {
        if (/[\uE000-\uE003]/.test(word[j])) continue;
        if (cleanI === orpIdx) { splitBefore = j; break; }
        cleanI++;
      }
      splitAfter = splitBefore + 1;
      while (splitAfter < word.length && /[\uE000-\uE003]/.test(word[splitAfter])) splitAfter++;

      beforeStr = word.substring(0, splitBefore);
      orpStr = word.substring(splitBefore, splitAfter);
      afterStr = word.substring(splitAfter);

      const bHtml = renderSupSub(beforeStr);
      const oHtml = renderSupSub(orpStr);
      const aHtml = renderSupSub(afterStr);
      if (bHtml !== null) wordBefore.innerHTML = bHtml; else wordBefore.textContent = beforeStr;
      if (oHtml !== null) wordOrp.innerHTML = oHtml; else wordOrp.textContent = orpStr;
      if (aHtml !== null) wordAfter.innerHTML = aHtml; else wordAfter.textContent = afterStr;
    } else {
      wordBefore.textContent = word.substring(0, orpIdx);
      wordOrp.textContent = word[orpIdx] || "";
      wordAfter.textContent = word.substring(orpIdx + 1);
    }

    // Apply inline formatting
    const fmt = wordFormats[index];
    wordDisplayEl.style.fontWeight = (fmt && fmt.bold) ? "600" : "";
    wordDisplayEl.style.fontStyle = (fmt && fmt.italic) ? "italic" : "";
    if (fmt && fmt.code) {
      wordDisplayEl.style.fontFamily = "'SF Mono', 'Consolas', 'Monaco', monospace";
    } else {
      wordDisplayEl.style.fontFamily = "";
    }
    // Strike wins over link underline if both present
    if (fmt && fmt.strike) {
      wordDisplayEl.style.textDecoration = "line-through";
    } else if (fmt && fmt.link) {
      wordDisplayEl.style.textDecoration = "underline";
      wordDisplayEl.style.textUnderlineOffset = "4px";
    } else {
      wordDisplayEl.style.textDecoration = "";
      wordDisplayEl.style.textUnderlineOffset = "";
    }

    // Render paren indicator BEFORE updating the stack for this word.
    // The opening-paren word already shows "(" in its text, so the indicator
    // starts on the NEXT word.
    renderParenIndicator();

    // Handle dash parenthetical (em/en dashes toggle as open/close)
    if (isDashToken(word)) {
      const dashIdx = parenStack.indexOf("\u2013");
      if (dashIdx >= 0) parenStack.splice(dashIdx, 1); // closing dash
      else parenStack.push("\u2013"); // opening dash
    }

    // Update paren stack with this word's parens
    pushParenOpens(word);
    const parenDepth = parenStack.length;
    popParenCloses(word);

    // Dim words inside parentheses/dashes by nesting level
    // Don't dim the dash delimiter tokens themselves
    if (parenDepth > 0 && !isDashToken(word)) {
      const reduction = [0, 0.30, 0.45, 0.50][Math.min(parenDepth, 3)] || 0.55;
      wordDisplayEl.style.opacity = String(1 - reduction);
    } else {
      wordDisplayEl.style.opacity = "";
    }

    // Hyphen continuation indicator
    if (hyphenContinuation[index]) {
      hyphenIndicatorEl.textContent = "-";
      hyphenIndicatorEl.style.opacity = "0.25";
    } else {
      hyphenIndicatorEl.textContent = "";
      hyphenIndicatorEl.style.opacity = "0";
    }

    // Heading indicator MUST run before positionWord so the indicator text
    // and any fontWeight override are part of the measured layout.
    renderHeadingIndicator(index);
    positionWord();

    wordCounter.textContent = `${index + 1} / ${words.length}`;
    animateProgress(index);
  }


  // ── Focus lines ──
  let focusLinesPlaced = false;
  const wordDisplayEl = document.getElementById("word-display");
  const parenIndicatorEl = document.getElementById("paren-indicator");
  const hyphenIndicatorEl = document.getElementById("hyphen-indicator");

  function placeFocusLines() {
    if (focusLinesPlaced) return;
    // Use the ORP element for precise vertical measurement — it always has content
    // during placement (called from positionWord after displayWord sets text).
    // Fall back to word-display if ORP is empty.
    const measureEl = wordOrp.textContent ? wordOrp : wordDisplayEl;
    const measureRect = measureEl.getBoundingClientRect();
    const containerRect = wordContainer.getBoundingClientRect();
    const textTop = measureRect.top - containerRect.top;
    const textBottom = measureRect.bottom - containerRect.top;
    const lineH = settings.focusLineHeight;
    const gap = 4;

    focusLineTop.style.top = (textTop - gap - lineH) + "px";
    focusLineTop.style.height = lineH + "px";

    focusLineBottom.style.top = (textBottom + gap) + "px";
    focusLineBottom.style.height = lineH + "px";

    focusLinesPlaced = true;
  }

  function positionWord() {
    wordDisplayEl.style.left = "0px";
    void wordDisplayEl.offsetWidth;

    const containerRect = wordContainer.getBoundingClientRect();
    const centerX = containerRect.width / 2;
    const orpRect = wordOrp.getBoundingClientRect();
    const orpCenterX = orpRect.left - containerRect.left + orpRect.width / 2;
    wordDisplayEl.style.left = (centerX - orpCenterX) + "px";

    placeFocusLines();
  }

  // Smooth progress bar
  let progressFrom = 0;
  let progressTo = 0;
  let progressStart = 0;
  let progressDuration = 200;
  let pendingDelay = 0; // set by tick() before displayWord() so animateProgress reuses it

  function animateProgress(index) {
    const currentWidth = parseFloat(progressBar.style.width) || 0;
    progressFrom = currentWidth;
    progressTo = ((index + 1) / words.length) * 100;
    progressDuration = playing && pendingDelay > 0 ? pendingDelay : 200;
    progressStart = performance.now();
    if (!progressAnimFrame) rafProgress();
  }

  function rafProgress() {
    const elapsed = performance.now() - progressStart;
    const t = Math.min(elapsed / progressDuration, 1);
    const value = progressFrom + (progressTo - progressFrom) * t;
    progressBar.style.width = value + "%";
    if (t < 1) {
      progressAnimFrame = requestAnimationFrame(rafProgress);
    } else {
      progressAnimFrame = null;
    }
  }

  // ── Full-text panel ──
  const fulltextPanel = document.getElementById("fulltext-panel");
  const fulltextScroll = document.getElementById("fulltext-scroll");
  let fulltextBuilt = false;
  let wordSpans = [];

  function buildFulltext() {
    if (fulltextBuilt) return;
    fulltextScroll.innerHTML = "";
    wordSpans = new Array(words.length);

    for (let p = 0; p < paragraphStarts.length - 1; p++) {
      const start = paragraphStarts[p];
      const end = paragraphStarts[p + 1];
      const type = paragraphTypes[p] || "paragraph";

      if (type === "image" && imageAtWord[start]) {
        const el = document.createElement("div");
        el.className = "ft-para ft-image";
        const img = document.createElement("img");
        img.src = imageAtWord[start].src;
        img.alt = imageAtWord[start].alt || "";
        img.className = "ft-img";
        el.appendChild(img);
        if (imageAtWord[start].alt) {
          const cap = document.createElement("div");
          cap.className = "ft-img-caption";
          cap.textContent = imageAtWord[start].alt;
          el.appendChild(cap);
        }
        const span = document.createElement("span");
        span.className = "ft-word";
        span.dataset.index = start;
        span.style.display = "none";
        wordSpans[start] = span;
        el.appendChild(span);
        fulltextScroll.appendChild(el);
        continue;
      }

      const el = document.createElement("div");
      const headingMatch = type.match(/^heading-(\d)$/);
      if (headingMatch) {
        el.className = "ft-para ft-heading ft-heading-" + headingMatch[1];
      } else if (type === "blockquote") {
        el.className = "ft-para ft-blockquote";
      } else if (type === "list-ul") {
        el.className = "ft-para ft-list-ul";
      } else if (type === "list-ol") {
        el.className = "ft-para ft-list-ol";
      } else {
        el.className = "ft-para";
      }

      // Group consecutive same-URL link words into a single <a> so the user
      // can click anywhere in a multi-word link.
      let currentAnchor = null;
      let currentAnchorUrl = null;
      for (let i = start; i < end; i++) {
        const fmt = wordFormats[i];
        const linkUrl = fmt && fmt.link ? fmt.link : null;

        if (linkUrl !== currentAnchorUrl) {
          currentAnchor = null;
          currentAnchorUrl = null;
        }

        if (i > start) {
          const prevFmt = wordFormats[i - 1];
          const prevUrl = prevFmt && prevFmt.link ? prevFmt.link : null;
          const separatorTarget = (prevUrl && prevUrl === linkUrl) ? currentAnchor : el;
          (separatorTarget || el).appendChild(document.createTextNode(" "));
        }

        const span = document.createElement("span");
        let cls = "ft-word";
        if (fmt) {
          if (fmt.bold) cls += " ft-bold";
          if (fmt.italic) cls += " ft-italic";
          if (fmt.code) cls += " ft-code";
          if (fmt.strike) cls += " ft-strike";
          if (fmt.link) cls += " ft-link";
        }
        span.className = cls;
        const supSubHtml = renderSupSub(words[i]);
        if (supSubHtml !== null) span.innerHTML = supSubHtml;
        else span.textContent = words[i];
        span.dataset.index = i;
        wordSpans[i] = span;

        if (linkUrl) {
          if (!currentAnchor) {
            currentAnchor = document.createElement("a");
            currentAnchor.href = linkUrl;
            currentAnchor.target = "_blank";
            currentAnchor.rel = "noopener noreferrer";
            currentAnchor.className = "ft-anchor";
            currentAnchor.title = linkUrl;
            currentAnchorUrl = linkUrl;
            el.appendChild(currentAnchor);
          }
          currentAnchor.appendChild(span);
        } else {
          el.appendChild(span);
        }
      }

      fulltextScroll.appendChild(el);
    }

    // Capture clicks that are part of a multi-click so an <a> inside a word
    // doesn't fire twice when the user double-clicks to navigate.
    fulltextScroll.addEventListener("click", (e) => {
      if (e.detail > 1 && e.target.closest("a")) {
        e.preventDefault();
      }
    }, true);

    fulltextScroll.addEventListener("dblclick", (e) => {
      const wordEl = e.target.closest(".ft-word");
      if (!wordEl) return;
      e.preventDefault();
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      const idx = parseInt(wordEl.dataset.index, 10);
      if (isNaN(idx)) return;
      navigateTo(idx);
      highlightCurrentInFulltext();
    });

    fulltextBuilt = true;
  }

  function highlightCurrentInFulltext() {
    const prev = fulltextScroll.querySelector(".ft-word.current");
    if (prev) prev.classList.remove("current");
    if (wordSpans[currentIndex]) {
      wordSpans[currentIndex].classList.add("current");
      const panel = fulltextPanel;
      const spanRect = wordSpans[currentIndex].getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const targetOffset = panelRect.height * 0.66;
      const spanTop = spanRect.top - panelRect.top + panel.scrollTop;
      panel.scrollTo({ top: spanTop - targetOffset, behavior: "smooth" });
    }
  }

  function showContext() {
    buildFulltext();
    fulltextPanel.classList.remove("hidden");
    requestAnimationFrame(() => highlightCurrentInFulltext());
  }

  function hideContext() {
    fulltextPanel.classList.add("hidden");
  }

  // ── Timing ──
  function getDelay(index) {
    const baseDelay = 60000 / settings.wpm;
    const word = stripMarkers(words[index] || "");
    let multiplier = 1;

    const lastChar = word[word.length - 1];
    if (lastChar === "." || lastChar === "!" || lastChar === "?") {
      multiplier = settings.periodDelayMultiplier;
    } else if (lastChar === ";") {
      multiplier = settings.semicolonDelayMultiplier;
    } else if (lastChar === ",") {
      const nextWord = words[index + 1];
      if (nextWord && /^\d/.test(nextWord)) {
        multiplier = 1;
      } else {
        multiplier = settings.commaDelayMultiplier;
      }
    } else if (lastChar === ":") {
      multiplier = settings.colonDelayMultiplier;
    } else if (word === "\u2014") {
      multiplier = settings.commaDelayMultiplier;
    }

    if (paragraphStarts.includes(index + 1) && multiplier < settings.paragraphDelayMultiplier) {
      multiplier = settings.paragraphDelayMultiplier;
    }

    const cleanLen = word.replace(/[^a-zA-Z0-9]/g, "").length;
    let extra = 0;
    if (cleanLen > settings.longWordThreshold) {
      extra = (cleanLen - settings.longWordThreshold) * settings.longWordExtraMs;
    }

    // Long numbers (>4 digits total, e.g. "12345", "2024-2026") get extra time
    const digitCount = (word.match(/\d/g) || []).length;
    if (digitCount > 4) {
      extra += (digitCount - 4) * 30;
    }

    const slashes = (word.match(/[\/]/g) || []).length;
    const enDashes = (word.match(/[\u2013]/g) || []).length;
    const emDashes = (word.match(/[\u2014]/g) || []).length;
    const compoundExtra = slashes * 0.8 + enDashes * 0.8 + emDashes * 0.53;
    if (compoundExtra > 0) {
      multiplier = Math.max(multiplier, 1 + compoundExtra);
    }

    const fmt = wordFormats[index];
    if (fmt && (fmt.bold || fmt.italic)) {
      multiplier = Math.max(multiplier, settings.emphasisDelayMultiplier);
    }

    const para = getParaForWord(index);
    const paraType = paragraphTypes[para] || "paragraph";
    if (paraType.startsWith("heading-")) {
      multiplier = Math.max(multiplier, settings.headingDelayMultiplier);
    }

    let delay = baseDelay * multiplier + extra;

    const nextIdx = index + 1;
    if (nextIdx < words.length && paragraphStarts.includes(nextIdx)) {
      const nextPara = getParaForWord(nextIdx);
      const nextType = paragraphTypes[nextPara] || "paragraph";
      if (nextType.startsWith("heading-")) {
        delay += settings.headingPauseMs;
      }
    }

    if (paraType.startsWith("heading-") && nextIdx < words.length && paragraphStarts.includes(nextIdx)) {
      delay += settings.headingPauseMs;
    }

    if (rampWordsRemaining > 0) {
      const progress = 1 - rampWordsRemaining / settings.rampUpWords;
      const speedFraction = currentRampFraction +
        (1 - currentRampFraction) * progress;
      delay = delay / speedFraction;
      rampWordsRemaining--;
    }

    return delay;
  }

  // ── Image overlay ──
  // Zoom state for the currently-displayed image. Reset whenever the overlay
  // is hidden or a new image is shown, so resuming regular text never leaves
  // a transform on the display element.
  let imageScale = 1;
  let imageX = 0;
  let imageY = 0;
  let imageDragging = false;
  let imageDragStart = { x: 0, y: 0, ix: 0, iy: 0 };

  function applyImageTransform() {
    imageDisplay.style.transform =
      `translate(${imageX}px, ${imageY}px) scale(${imageScale})`;
    imageDisplay.style.cursor = imageScale > 1 ? (imageDragging ? "grabbing" : "grab") : "";
  }

  function resetImageTransform() {
    imageScale = 1;
    imageX = 0;
    imageY = 0;
    imageDragging = false;
    imageDisplay.style.transform = "";
    imageDisplay.style.cursor = "";
  }

  function showImageOverlay(imgData) {
    resetImageTransform();
    imageDisplay.src = imgData.src;
    imageDisplay.alt = imgData.alt;
    imageCaption.textContent = imgData.alt || "";
    imageOverlay.classList.remove("hidden");
    imageDisplay.onerror = () => {
      hideImageOverlay();
      if (!playing) play();
    };
    pause();
  }

  function hideImageOverlay() {
    imageOverlay.classList.add("hidden");
    imageDisplay.src = "";
    imageDisplay.onerror = null;
    resetImageTransform();
  }

  // Touchpad pinch-to-zoom: browsers send these as wheel events with ctrlKey=true.
  // Also supports regular ctrl+scroll on a mouse.
  imageOverlay.addEventListener("wheel", (e) => {
    if (imageOverlay.classList.contains("hidden")) return;
    if (!e.ctrlKey) return;
    e.preventDefault();
    const rect = imageDisplay.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const prev = imageScale;
    const target = Math.max(1, Math.min(6, prev * Math.exp(-e.deltaY * 0.01)));
    const ratio = target / prev;
    imageX = cx - (cx - imageX) * ratio;
    imageY = cy - (cy - imageY) * ratio;
    imageScale = target;
    if (imageScale === 1) { imageX = 0; imageY = 0; }
    applyImageTransform();
  }, { passive: false });

  // Pan by dragging when zoomed in
  imageDisplay.addEventListener("mousedown", (e) => {
    if (imageScale <= 1) return;
    imageDragging = true;
    imageDragStart = { x: e.clientX, y: e.clientY, ix: imageX, iy: imageY };
    applyImageTransform();
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!imageDragging) return;
    imageX = imageDragStart.ix + (e.clientX - imageDragStart.x);
    imageY = imageDragStart.iy + (e.clientY - imageDragStart.y);
    applyImageTransform();
  });
  window.addEventListener("mouseup", () => {
    if (!imageDragging) return;
    imageDragging = false;
    applyImageTransform();
  });
  imageDisplay.addEventListener("dblclick", (e) => {
    e.preventDefault();
    resetImageTransform();
  });

  // ── Playback ──
  function play() {
    if (currentIndex >= words.length) {
      currentIndex = 0;
    }
    hideImageOverlay();

    const pauseMs = pausedAtTime > 0 ? (Date.now() - pausedAtTime) : Infinity;
    if (pauseMs <= settings.resumeQuickMs) {
      currentRampFraction = settings.resumeQuickFraction;
    } else if (pauseMs <= settings.resumeMediumMs) {
      currentRampFraction = settings.resumeMediumFraction;
    } else {
      currentRampFraction = settings.rampUpStartFraction;
    }

    rebuildParenStack(currentIndex - 1);
    playing = true;
    rampWordsRemaining = settings.rampUpWords;
    clearTimeout(pauseContextTimer);
    hideContext();
    pauseIndicator.classList.add("hidden");
    btnPause.innerHTML = "&#9646;&#9646;";
    tick();
  }

  let pauseContextTimer = null;
  function pause() {
    playing = false;
    clearTimeout(timer);
    pausedAtTime = Date.now();
    pauseIndicator.classList.remove("hidden");
    btnPause.textContent = "\u25B6";
    clearTimeout(pauseContextTimer);
    pauseContextTimer = setTimeout(showContext, 150);
  }

  function togglePause() {
    if (playing) pause();
    else play();
  }

  function tick() {
    if (!playing) return;
    if (currentIndex >= words.length) {
      pause();
      return;
    }

    if (imageAtWord[currentIndex]) {
      showImageOverlay(imageAtWord[currentIndex]);
      currentIndex++;
      return;
    }

    // Compute delay ONCE, before displayWord → animateProgress reuses it via pendingDelay.
    // (getDelay mutates rampWordsRemaining, so calling it twice per word was a bug.)
    pendingDelay = getDelay(currentIndex);
    displayWord(currentIndex);
    applyTargetRamp();
    currentIndex++;
    timer = setTimeout(tick, pendingDelay);
  }

  // ── Navigation ──
  function navigateTo(index) {
    rebuildParenStack(index - 1);
    if (imageAtWord[index]) {
      showImageOverlay(imageAtWord[index]);
      currentIndex = index + 1;
      return;
    }
    hideImageOverlay();
    displayWord(index);
    showContext();
  }

  function wordBack() {
    if (playing) pause();
    currentIndex = Math.max(0, currentIndex - 1);
    navigateTo(currentIndex);
  }

  function wordForward() {
    if (playing) pause();
    currentIndex = Math.min(words.length - 1, currentIndex + 1);
    navigateTo(currentIndex);
  }

  function paragraphBack() {
    if (playing) pause();
    let paraIdx = 0;
    for (let i = 0; i < paragraphStarts.length - 1; i++) {
      if (paragraphStarts[i] <= currentIndex) paraIdx = i;
      else break;
    }
    if (currentIndex === paragraphStarts[paraIdx] && paraIdx > 0) {
      paraIdx--;
    }
    currentIndex = paragraphStarts[paraIdx];
    navigateTo(currentIndex);
  }

  function paragraphForward() {
    if (playing) pause();
    for (let i = 0; i < paragraphStarts.length - 1; i++) {
      if (paragraphStarts[i] > currentIndex) {
        currentIndex = paragraphStarts[i];
        navigateTo(currentIndex);
        return;
      }
    }
    currentIndex = words.length - 1;
    navigateTo(currentIndex);
    showContext();
  }

  function adjustSpeed(delta) {
    settings.wpm = Math.max(10, settings.wpm + delta);
    recalcTargetRampRate();
    updateWpmDisplay();
    if (playing) {
      clearTimeout(timer);
      const delay = getDelay(Math.max(0, currentIndex - 1));
      timer = setTimeout(tick, delay);
    }
  }

  // ── Target speed ramp ──
  // Logistic S-curve: slow start, fast middle, slow finish
  // Returns 0..1 for input t in 0..1
  function logisticEase(t) {
    // Steepness k=10 gives a nice S-shape within [0,1]
    const k = 10;
    const mid = 0.5;
    const raw = 1 / (1 + Math.exp(-k * (t - mid)));
    // Normalize so logisticEase(0)=0 and logisticEase(1)=1
    const low = 1 / (1 + Math.exp(-k * (0 - mid)));
    const high = 1 / (1 + Math.exp(-k * (1 - mid)));
    return (raw - low) / (high - low);
  }

  function initTargetRamp() {
    targetRampStartWpm = settings.wpm;
    targetRampWordsPlayed = 0;
    const avgWpm = (settings.wpm + settings.targetWpm) / 2;
    targetRampTotalWords = Math.max(1, avgWpm * settings.targetWpmRampMinutes);
  }

  function recalcTargetRampRate() {
    if (!targetRampActive || !settings.targetWpm || settings.wpm >= settings.targetWpm) return;
    // Re-anchor the ramp from current position
    initTargetRamp();
  }

  function toggleTargetRamp() {
    if (!settings.targetWpm || settings.targetWpm <= 0) return;
    targetRampActive = !targetRampActive;
    if (targetRampActive) initTargetRamp();
    updateWpmDisplay();
  }

  function applyTargetRamp() {
    if (!targetRampActive || !settings.targetWpm || settings.targetWpm <= 0) return;
    if (settings.wpm >= settings.targetWpm) {
      settings.wpm = settings.targetWpm;
      updateWpmDisplay();
      return;
    }
    targetRampWordsPlayed++;
    const t = Math.min(targetRampWordsPlayed / targetRampTotalWords, 1);
    const eased = logisticEase(t);
    const newWpm = Math.round(targetRampStartWpm + (settings.targetWpm - targetRampStartWpm) * eased);
    settings.wpm = Math.min(newWpm, settings.targetWpm);
    updateWpmDisplay();
  }

  function updateWpmDisplay() {
    if (targetRampActive && settings.targetWpm > 0) {
      wpmDisplay.innerHTML = "<span style=\"color:var(--orp)\">" + settings.wpm + "</span> \u2192 <em>" + settings.targetWpm + "</em> WPM";
    } else {
      wpmDisplay.textContent = settings.wpm + " WPM";
    }
  }

  // ── Theme ──
  function isDark() {
    if (settings.darkMode === "dark") return true;
    if (settings.darkMode === "light") return false;
    if (settings.darkMode === true) return true;
    if (settings.darkMode === false) return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme() {
    const root = document.documentElement;
    const dark = isDark();
    root.style.setProperty("--bg", dark ? settings.darkBackgroundColor : settings.backgroundColor);
    root.style.setProperty("--text", dark ? settings.darkTextColor : settings.textColor);
    root.style.setProperty("--orp", dark ? settings.darkOrpColor : settings.orpColor);
    root.style.setProperty("--focus-line", dark ? settings.darkFocusLineColor : settings.focusLineColor);
    root.style.setProperty("--focus-line-w", settings.focusLineWidth + "px");
    root.style.setProperty("--focus-line-h", settings.focusLineHeight + "px");
    root.style.setProperty("--font-size", settings.fontSize + "px");
    root.style.setProperty("--context-opacity", settings.contextOpacity);
    document.body.style.fontFamily = settings.fontFamily;
  }


  // ── Event handlers ──
  document.addEventListener("keydown", (e) => {
    if (!startOverlay.classList.contains("hidden")) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        start();
      }
      return;
    }

    const key = e.key;

    if (key === settings.keyPause) {
      e.preventDefault();
      togglePause();
    } else if (key === settings.keySlower) {
      e.preventDefault();
      adjustSpeed(-settings.wpmStep);
    } else if (key === settings.keyFaster) {
      e.preventDefault();
      adjustSpeed(settings.wpmStep);
    } else if (key === settings.keyWordBack) {
      e.preventDefault();
      wordBack();
    } else if (key === settings.keyWordForward) {
      e.preventDefault();
      wordForward();
    } else if (key === settings.keyParagraphBack) {
      e.preventDefault();
      paragraphBack();
    } else if (key === settings.keyParagraphForward) {
      e.preventDefault();
      paragraphForward();
    } else if (key === "w" || key === "W") {
      e.preventDefault();
      toggleTargetRamp();
    } else if (key === "Escape") {
      if (!tocOverlay.classList.contains("hidden")) {
        tocOverlay.classList.add("hidden");
      }
    }
  });

  // Button controls
  btnPause.addEventListener("click", togglePause);
  document.getElementById("btn-word-back").addEventListener("click", wordBack);
  document.getElementById("btn-word-fwd").addEventListener("click", wordForward);
  document.getElementById("btn-para-back").addEventListener("click", paragraphBack);
  document.getElementById("btn-para-fwd").addEventListener("click", paragraphForward);
  document.getElementById("btn-slower").addEventListener("click", () => adjustSpeed(-settings.wpmStep));
  document.getElementById("btn-faster").addEventListener("click", () => adjustSpeed(settings.wpmStep));

  // ── Touch zone interactions ──
  // Tap: toggle pause.  Hold: freeze word (soft pause).  Swipe: adjust speed.
  // Hold+swipe: freeze word + adjust speed.
  const touchZone = document.getElementById("touch-zone");
  const wpmToast = document.getElementById("wpm-toast");
  let toastTimeout = null;

  function showWpmToast() {
    wpmToast.textContent = settings.wpm + " WPM";
    wpmToast.classList.add("visible");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => wpmToast.classList.remove("visible"), 800);
    // Recalculate target ramp rate since speed changed via swipe
    recalcTargetRampRate();
  }

  const HOLD_DELAY = 200;   // ms before a press counts as "hold"
  const MOVE_THRESHOLD = 8; // px before a touch counts as "swipe"

  let touchStartX = null;
  let touchStartTime = 0;
  let touchBaseWpm = 0;
  let touchMoved = false;    // true once movement exceeds threshold
  let touchHeld = false;     // true once hold timer fires
  let holdTimer = null;
  let wasPlayingBeforeHold = false;  // remember playback state before hold-freeze
  let softFrozen = false;    // true during hold-freeze (no fulltext panel)

  touchZone.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartTime = Date.now();
    touchBaseWpm = settings.wpm;
    touchMoved = false;
    touchHeld = false;
    softFrozen = false;
    wasPlayingBeforeHold = playing;

    // Only enable hold/swipe when playing (not when fully paused with fulltext)
    if (playing) {
      holdTimer = setTimeout(() => {
        touchHeld = true;
        if (!touchMoved) {
          // Soft-freeze: stop advancing words but don't show fulltext
          softFrozen = true;
          clearTimeout(timer);
          playing = false;
        }
      }, HOLD_DELAY);
    }
  }, { passive: true });

  touchZone.addEventListener("touchmove", (e) => {
    if (touchStartX === null) return;
    // No swipe interaction when fully paused
    if (!wasPlayingBeforeHold && !softFrozen) return;

    const dx = e.touches[0].clientX - touchStartX;

    if (!touchMoved && Math.abs(dx) > MOVE_THRESHOLD) {
      touchMoved = true;
      // Cancel hold timer — this is a swipe, not a hold
      clearTimeout(holdTimer);
    }

    if (touchMoved) {
      // Adjust speed: 1 WPM per 2px
      const delta = Math.round(dx / 2);
      const newWpm = Math.max(10, touchBaseWpm + delta);
      if (newWpm !== settings.wpm) {
        settings.wpm = newWpm;
        updateWpmDisplay();
        showWpmToast();
      }
    }
  }, { passive: true });

  touchZone.addEventListener("touchend", () => {
    clearTimeout(holdTimer);

    if (!touchMoved && !touchHeld) {
      // Quick tap: toggle pause
      togglePause();
    } else if (softFrozen) {
      // Release from hold (or hold+swipe): resume if was playing
      if (wasPlayingBeforeHold) {
        playing = true;
        rampWordsRemaining = 0; // no ramp-up, continue at speed
        tick();
      }
      softFrozen = false;
    }
    // Pure swipe while playing: speed was adjusted live, nothing to resume

    touchStartX = null;
  }, { passive: true });

  touchZone.addEventListener("touchcancel", () => {
    clearTimeout(holdTimer);
    if (softFrozen && wasPlayingBeforeHold) {
      playing = true;
      rampWordsRemaining = 0;
      tick();
      softFrozen = false;
    }
    touchStartX = null;
  }, { passive: true });

  // ── ToC ──
  function buildToc() {
    tocList.innerHTML = "";
    if (headings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc-empty";
      empty.textContent = "No headings found in this text.";
      tocList.appendChild(empty);
      return;
    }
    for (const h of headings) {
      const btn = document.createElement("button");
      btn.className = "toc-item toc-h" + h.level;
      btn.textContent = h.text;
      btn.addEventListener("click", () => {
        tocOverlay.classList.add("hidden");
        if (playing) pause();
        navigateTo(h.wordIndex);
        if (!playing) {
          highlightCurrentInFulltext();
        }
      });
      tocList.appendChild(btn);
    }
  }

  document.getElementById("btn-toc").addEventListener("click", () => {
    buildToc();
    tocOverlay.classList.toggle("hidden");
  });
  document.getElementById("toc-close").addEventListener("click", () => {
    tocOverlay.classList.add("hidden");
  });
  tocOverlay.addEventListener("click", (e) => {
    if (e.target === tocOverlay) tocOverlay.classList.add("hidden");
  });

  // Start overlay
  function start() {
    startOverlay.classList.add("hidden");
    displayWord(0);
    play();
  }

  startOverlay.addEventListener("click", start);
  // Ensure tap works on mobile (some browsers delay click on elements without touch handlers)
  startOverlay.addEventListener("touchend", (e) => {
    if (!startOverlay.classList.contains("hidden")) {
      e.preventDefault();
      start();
    }
  });

  // Window resize
  window.addEventListener("resize", () => {
    focusLinesPlaced = false;
    if (currentIndex >= 0 && currentIndex < words.length) {
      positionWord();
    }
  });
})();
