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
    return String(text || "").normalize("NFKC").replace(/\r/g, "").replace(/クエス卜/g, "クエスト")
      .replace(/クエスト\s*[Il|](?=\s|$)/g, "クエスト1")
      .replace(/([+＋]?)\s*[Y羊]\s*(?=\d{1,3}[,.]\d{3})/g, "$1¥");
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
      const row = rows.find(item => item.lines.every(other => box.x0 >= other.bbox.x1 || box.x1 <= other.bbox.x0) &&
        (Math.abs(item.center - center) < Math.min(item.height, height) * 0.55 ||
          item.lines.some(other => Math.min(box.y1, other.bbox.y1) - Math.max(box.y0, other.bbox.y0) >= Math.min(height, other.bbox.y1 - other.bbox.y0) * 0.6)));
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
    const compact = normalize(text).replace(/\s/g, "").replace(/(\d{1,2}):[.,](\d{2})/g, "$1:$2");
    const dated = compact.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:\(([日月火水木金土])\))?(\d{1,2}):(\d{2})[〜~～へー\-–—]+(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:\(([日月火水木金土])\))?(\d{1,2}):(\d{2})/);
    if (dated) {
      const startTime = clock(null, dated[5], dated[6]); const endTime = clock(null, dated[11], dated[12]);
      if (!startTime || !endTime) return null;
      const currentYear = new Date(now + JST).getUTCFullYear();
      const years = dated[1] ? [Number(dated[1])] : [currentYear - 1, currentYear, currentYear + 1];
      const periods = years.flatMap(year => {
        const endYear = dated[7] ? Number(dated[7]) : year + (Number(dated[8]) < Number(dated[2]) ? 1 : 0);
        const start = new Date(Date.UTC(year, Number(dated[2]) - 1, Number(dated[3])));
        const end = new Date(Date.UTC(endYear, Number(dated[8]) - 1, Number(dated[9])));
        if (start.getUTCMonth() + 1 !== Number(dated[2]) || start.getUTCDate() !== Number(dated[3]) || end.getUTCMonth() + 1 !== Number(dated[8]) || end.getUTCDate() !== Number(dated[9]) ||
            (dated[4] && start.getUTCDay() !== "日月火水木金土".indexOf(dated[4])) || (dated[10] && end.getUTCDay() !== "日月火水木金土".indexOf(dated[10]))) return [];
        const startDate = start.toISOString().slice(0, 10); const endDate = end.toISOString().slice(0, 10);
        const startAt = Date.parse(`${startDate}T${startTime}:00+09:00`); const endAt = Date.parse(`${endDate}T${endTime}:00+09:00`);
        if (endAt <= startAt || endAt - startAt > 35 * DAY) return [];
        return [{ startDate, endDate, startTime, endTime, inferred: !dated[1] || !dated[7], dateSource: "calendar", next: false,
          template: start.getUTCDay() === 1 && end.getUTCDay() === 5 ? "weekday" : start.getUTCDay() === 5 && end.getUTCDay() === 1 ? "weekend" : "custom", distance: Math.abs(now - startAt) }];
      });
      const best = periods.sort((a, b) => a.distance - b.distance)[0];
      if (!best) return null;
      delete best.distance; return best;
    }
    // A selection deadline contains one weekday; it must never become the quest period.
    const pattern = /([日月火水木金土])曜日(午前|午後)?(\d{1,2})時(?:(\d{1,2})分)?[〜~～へー\-–—]+([日月火水木金土])曜日(午前|午後)?(\d{1,2})時(?:(\d{1,2})分)?/;
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
    const endMinutes = minutes(endTime) + (endTime === "03:59" ? 1 : 0);
    if (next ? start - JST + minutes(startTime) * 60000 <= now : start + span * DAY - JST + endMinutes * 60000 <= now) start += 7 * DAY;
    return {
      startDate: new Date(start).toISOString().slice(0, 10), startTime,
      endDate: new Date(start + span * DAY).toISOString().slice(0, 10), endTime,
      inferred: true, next,
      template: startDay === 5 && endDay === 1 ? "weekend" : startDay === 1 && endDay === 5 ? "weekday" : "custom"
    };
  }

  function parseText(text, now = Date.now()) {
    if (/クエストの進捗|\d+\/\d+(?:回|件)/.test(normalize(text).replace(/\s/g, ""))) return parseProgress(text, now);
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

  function parseProgress(text, now) {
    const rows = normalize(text).split("\n");
    const period = readPeriod(text, now);
    const reject = () => ({ candidates: [], skipped: 1, period });
    const converted = ["クエスト1"];
    let completed = null; let target = null;
    for (const row of rows) {
      const compact = row.replace(/\s/g, "");
      if (/^詳細/.test(compact)) break;
      const progress = row.match(/(?:^|[^\d.,\-−A-Za-z])(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:回|件)/);
      if (progress) {
        // A later-stage progress fraction does not establish the full period total.
        if (completed !== null) return reject();
        completed = Number(progress[1]); target = Number(progress[2]);
        if (completed > target || target < 1) return reject();
        converted.push(`${target}回${row.slice(progress.index + progress[0].length)}`);
      } else if (completed !== null) {
        const count = row.match(/(?:^|[^\d.,+\-−A-Za-z])(\+)?(\d{1,4})\s*(?:回|件)/);
        // Locked bonus tiers omit '+' on the count but retain it on the reward.
        if (count) converted.push(`+${Number(count[2])}回${row.slice(count.index + count[0].length)}`);
        else converted.push(row);
      }
    }
    if (completed === null) return reject();
    const remaining = normalize(text).replace(/\s/g, "").match(/あと(\d{1,4})回/);
    if (remaining && Number(remaining[1]) + completed !== target) return reject();
    const result = parseText(converted.join("\n"), now);
    return { ...result, period, candidates: result.candidates.map(candidate => ({ ...candidate, label: "進行中のクエスト", completed })) };
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

  function imageCanvas(file, enhance = true) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40000000) throw new Error("画像が大きすぎます。スクリーンショットを選んでください。");
          const scale = Math.min(1, 1600 / img.naturalWidth, 5000 / img.naturalHeight, Math.sqrt(6000000 / (img.naturalWidth * img.naturalHeight)));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          if (!enhance) { resolve(canvas); return; }
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
          cachePath: "ubereats-quest-jpn-v1",
          logger: item => { if (!stopped && item.status === "recognizing text") onProgress(`画像を読み取り中…${Math.round(item.progress * 100)}%`); },
          errorHandler: () => {}
        });
        if (stopped) { await worker.terminate(); return; }
        await worker.setParameters({ tessedit_pageseg_mode: "11" });
        const attempts = [];
        const inputSize = `${canvas.width}×${canvas.height}`;
        async function read(input) {
          const { data } = await worker.recognize(input, {}, { text: true, blocks: true });
          const arranged = textFromBlocks(data);
          attempts.push(arranged || data.text || "（文字を読み取れませんでした）");
          // If row grouping is unsuccessful, also try the engine's original line order.
          let parsed = parseText(arranged);
          if (!parsed.candidates.length && data.text && data.text !== arranged) {
            const original = parseText(data.text);
            attempts.push(data.text);
            if (original.candidates.length) parsed = original;
          }
          return parsed;
        }
        let parsed = await read(canvas);
        canvas.width = canvas.height = 1;
        if ((!parsed.candidates.length || !parsed.period) && !stopped) {
          onProgress("別の画像処理で、もう一度読み取り中…");
          const original = await imageCanvas(file, false);
          if (stopped) return;
          const alternative = await read(original);
          if (!parsed.candidates.length) parsed = alternative;
          else if (!parsed.period && alternative.period) parsed = { ...parsed, period: alternative.period };
          original.width = original.height = 1;
        }
        return { ...parsed, diagnosticText: `読み取り v70（処理画像 ${inputSize}px）\n${attempts.map((text, i) => `--- 結果${i + 1} ---\n${text}`).join("\n")}` };
      })();
      return await Promise.race([job, interruption]);
    } finally {
      stopped = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (worker) await worker.terminate();
    }
  }

  return { version: "70", parseText, readPeriod, textFromBlocks, recognize };
});
