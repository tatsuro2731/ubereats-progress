(function exposeQuestImage(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UberQuestImage = api;
})(typeof window === "undefined" ? this : window, function questImageFactory() {
  "use strict";
  const DAY = 86400000;
  const JST = 9 * 60 * 60000;
  const CDN = "https://cdn.jsdelivr.net/npm/";
  let libraryPromise;

  function normalize(text) {
    return String(text || "").normalize("NFKC").replace(/\r/g, "").replace(/クエス卜/g, "クエスト");
  }

  // Sparse OCR reads the two columns separately. Restore visual row order before parsing.
  function textFromBlocks(data) {
    const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []))
      .filter(line => line.bbox && line.text && line.text.trim())
      .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    const rows = [];
    for (const line of lines) {
      const box = line.bbox;
      const center = (box.y0 + box.y1) / 2;
      const height = box.y1 - box.y0;
      const row = rows.find(item => Math.abs(item.center - center) < Math.min(item.height, height) * 0.55);
      if (row) row.lines.push(line);
      else rows.push({ center, height, lines: [line] });
    }
    return rows.length ? rows.sort((a, b) => a.center - b.center).map(row => row.lines.sort((a, b) => a.bbox.x0 - b.bbox.x0).map(line => line.text.trim()).join(" ")).join("\n") : data.text || "";
  }

  function clock(meridiem, hour, minute) {
    let h = Number(hour); const m = Number(minute || 0);
    if (m > 59 || (meridiem ? h > 12 : h > 23)) return null;
    if (meridiem === "午前") h %= 12;
    if (meridiem === "午後") h = h % 12 + 12;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function readPeriod(text, now = Date.now()) {
    const compact = normalize(text).replace(/\s/g, "");
    // A selection deadline contains one weekday; it must never become the quest period.
    const pattern = /([日月火水木金土])曜日(午前|午後)?(\d{1,2})時(?:(\d{1,2})分)?[〜~～へ\-–—]+([日月火水木金土])曜日(午前|午後)?(\d{1,2})時(?:(\d{1,2})分)?/;
    const match = compact.match(pattern);
    if (!match) return null;
    const startTime = clock(match[2], match[3], match[4]);
    const endTime = clock(match[6], match[7], match[8]);
    if (!startTime || !endTime) return null;
    const startDay = "日月火水木金土".indexOf(match[1]);
    const endDay = "日月火水木金土".indexOf(match[5]);
    const date = new Date(now + JST);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    let start = midnight - ((date.getUTCDay() - startDay + 7) % 7) * DAY;
    const span = (endDay - startDay + 7) % 7 || (minutes(endTime) > minutes(startTime) ? 0 : 7);
    const next = /次のクエスト|クエストを選択できるのはあと/.test(compact);
    if (next ? start - JST + minutes(startTime) * 60000 <= now : start + span * DAY - JST + minutes(endTime) * 60000 <= now) start += 7 * DAY;
    return {
      startDate: new Date(start).toISOString().slice(0, 10), startTime,
      endDate: new Date(start + span * DAY).toISOString().slice(0, 10), endTime,
      inferred: true, next,
      template: startDay === 5 && endDay === 1 ? "weekend" : startDay === 1 && endDay === 5 ? "weekday" : "custom"
    };
  }

  function parseText(text, now = Date.now()) {
    const lines = normalize(text).split("\n").map(line => line.replace(/\s/g, "")).filter(Boolean);
    const candidates = [];
    let current = null;
    let pending = null;
    let skipped = 0;
    function finish() {
      if (!current) return;
      if (pending || current.invalid || !current.tiers.length) skipped++;
      else candidates.push({ label: current.label, tiers: current.tiers });
      current = null; pending = null;
    }
    for (const line of lines) {
      const heading = line.match(/^クエスト([1-9]\d?)(?:$|[^\d])/);
      if (heading) {
        finish(); current = { label: `クエスト${heading[1]}`, tiers: [], invalid: false }; continue;
      }
      const count = line.match(/(?:^|[^\d.,+\-−A-Za-z])(\+)?(\d{1,4})(?:回(?:の乗車|の配達)?|件(?:の配達)?)/);
      // Japanese OCR sometimes reads the yen glyph as a backslash/半 and a thousands comma as a dot.
      const amount = line.match(/(\+)?[¥￥\\半]+([\d,.]+)(?![\dA-Za-z.,])/);
      if (current && ((!count && /[回件]/.test(line) && /\d/.test(line)) || /[\-−][¥￥\\半]/.test(line) || (amount && !pending && !count))) current.invalid = true;
      if (count) {
        if (!current) current = { label: "読み取ったクエスト", tiers: [], invalid: false };
        if (pending) current.invalid = true;
        pending = { count: Number(count[2]), extra: Boolean(count[1]) };
      }
      if (current && pending && amount) {
        const number = amount[2];
        const reward = Number(number.replace(/[,.]/g, ""));
        const previous = current.tiers.at(-1);
        const target = pending.extra && previous ? previous.target + pending.count : pending.count;
        if (!/^(?:\d+|\d{1,3}(?:[,.]\d{3})+)$/.test(number) || !Number.isInteger(reward) || reward > 9999999 ||
            target < 1 || target > 9999 || (pending.extra && !previous) || (previous && target <= previous.target) || current.tiers.length >= 5 ||
            (!previous && Boolean(amount[1])) || (pending.extra !== Boolean(amount[1]))) current.invalid = true;
        current.tiers.push({ target, reward });
        pending = null;
      }
    }
    finish();
    return { candidates, skipped, period: readPeriod(text, now) };
  }

  function loadLibrary() {
    if (typeof window.Tesseract?.createWorker === "function") return Promise.resolve(window.Tesseract);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const fail = () => { clearTimeout(timer); script.remove(); libraryPromise = null; reject(new Error("読み取り機能を準備できませんでした。通信を確認して、もう一度お試しください。")); };
      const timer = setTimeout(fail, 30000);
      script.src = `${CDN}tesseract.js@7.0.0/dist/tesseract.min.js`;
      script.integrity = "sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM";
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      script.onload = () => { clearTimeout(timer); if (window.Tesseract?.createWorker) resolve(window.Tesseract); else fail(); };
      script.onerror = fail;
      document.head.appendChild(script);
    });
    return libraryPromise;
  }

  function imageCanvas(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40000000) throw new Error("画像が大きすぎます。スクリーンショットを選んでください。");
          const scale = Math.min(1.5, 1400 / img.naturalWidth, 5000 / img.naturalHeight, Math.sqrt(6000000 / (img.naturalWidth * img.naturalHeight)));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          let dark = 0; let samples = 0;
          for (let i = 0; i < pixels.data.length; i += 400) { if (Math.max(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) < 128) dark++; samples++; }
          const invert = dark > samples / 2;
          for (let i = 0; i < pixels.data.length; i += 4) {
            let value = Math.max(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
            if (invert) value = 255 - value;
            pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
          }
          context.putImageData(pixels, 0, 0);
          resolve(canvas);
        } catch (error) { reject(error); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を開けませんでした。PNGまたはJPEGのスクリーンショットを選んでください。")); };
      img.src = url;
    });
  }

  async function recognize(file, { signal, onProgress = () => {} } = {}) {
    if (!file || file.size > 20 * 1024 * 1024) throw new Error("20MB以下のスクリーンショットを選んでください。");
    if (!/image\/(png|jpeg|webp)/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error("PNG・JPEG・WebP形式の画像を選んでください。");
    let worker;
    let stopped = false;
    let timer;
    let abort;
    const interruption = new Promise((_, reject) => {
      abort = () => { stopped = true; reject(new DOMException("読み取りを中止しました。", "AbortError")); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { stopped = true; reject(new Error("読み取りに時間がかかっています。通信を確認するか、クエスト部分だけの画像でお試しください。")); }, 90000);
    });
    try {
      const job = (async () => {
        onProgress("読み取りの準備中…初回は少し時間がかかります。");
        const [library, canvas] = await Promise.all([loadLibrary(), imageCanvas(file)]);
        if (stopped) return;
        worker = await library.createWorker("jpn", 1, {
          workerPath: `${CDN}tesseract.js@7.0.0/dist/worker.min.js`,
          corePath: `${CDN}tesseract.js-core@7.0.0`,
          langPath: `${CDN}@tesseract.js-data/jpn@1.0.0/4.0.0_best_int`,
          logger: item => { if (!stopped && item.status === "recognizing text") onProgress(`画像を読み取り中…${Math.round(item.progress * 100)}%`); },
          errorHandler: () => {}
        });
        if (stopped) { await worker.terminate(); return; }
        await worker.setParameters({ tessedit_pageseg_mode: "11" });
        const result = await worker.recognize(canvas, {}, { text: true, blocks: true });
        canvas.width = canvas.height = 1;
        return parseText(textFromBlocks(result.data));
      })();
      return await Promise.race([job, interruption]);
    } finally {
      stopped = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (worker) await worker.terminate();
    }
  }

  return { parseText, readPeriod, textFromBlocks, recognize };
});
