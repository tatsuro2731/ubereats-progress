(function exposeQuestImageCrop(root) {
  "use strict";

  const INITIAL_TOP = 18;
  const INITIAL_BOTTOM = 57;

  function abortError() {
    return new DOMException("画像の切り出しを中止しました。", "AbortError");
  }

  async function loadImage(file, signal) {
    if (signal?.aborted) throw abortError();
    if (!file || file.size > 20 * 1024 * 1024) throw new Error("20MB以下の画像を選んでください。");
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const has = (offset, signature) => signature.every((byte, i) => bytes[offset + i] === byte);
    if (!has(0, [0xff, 0xd8, 0xff]) && !has(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
        !(has(0, [82, 73, 70, 70]) && has(8, [87, 69, 66, 80]))) {
      throw new Error("PNG・JPEG・WebP形式の画像を選んでください。");
    }
    if (signal?.aborted) throw abortError();
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        const abort = () => {
          image.removeAttribute("src");
          reject(abortError());
        };
        signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        image.onerror = () => {
          signal?.removeEventListener("abort", abort);
          reject(new Error("画像を開けませんでした。別のスクリーンショットを選んでください。"));
        };
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
      image.onload = image.onerror = null;
    }
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) {
      image.removeAttribute("src");
      throw new Error("画像が大きすぎます。クエスト部分を切り出した画像を選んでください。");
    }
    return image;
  }

  function drawCrop(image, canvas, start, end) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("画像の切り出しを準備できませんでした。");
    const width = image.naturalWidth;
    const y = Math.floor(image.naturalHeight * start / 100);
    const height = Math.max(1, Math.ceil(image.naturalHeight * end / 100) - y);
    const scale = Math.min(1, 1600 / width, 2200 / height, Math.sqrt(3000000 / (width * height)));
    const outWidth = Math.max(1, Math.floor(width * scale));
    const outHeight = Math.max(1, Math.floor(height * scale));
    if (canvas.width !== outWidth) canvas.width = outWidth;
    if (canvas.height !== outHeight) canvas.height = outHeight;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, outWidth, outHeight);
    context.drawImage(image, 0, y, width, height, 0, 0, outWidth, outHeight);
  }

  function encode(canvas) {
    const url = canvas.toDataURL("image/jpeg", 0.9);
    if (!url.startsWith("data:image/jpeg;base64,")) throw new Error("送信用の画像を作成できませんでした。");
    return url;
  }

  async function defaultJpeg(file, { signal } = {}) {
    const image = await loadImage(file, signal);
    const canvas = document.createElement("canvas");
    try {
      if (signal?.aborted) throw abortError();
      drawCrop(image, canvas, INITIAL_TOP, INITIAL_BOTTOM);
      return encode(canvas);
    } finally {
      image.removeAttribute("src");
      canvas.width = canvas.height = 1;
    }
  }

  async function open(file, container, { signal } = {}) {
    const image = await loadImage(file, signal);
    if (signal?.aborted) throw abortError();
    const panel = document.createElement("div");
    panel.className = "questApiCrop";
    const help = document.createElement("p");
    help.textContent = "残り件数の説明文、現在の進捗、追加報酬のすべてが入るように上下を調整してください。ここに表示された範囲を送信します。";
    const preview = document.createElement("canvas");
    preview.setAttribute("role", "img");
    preview.setAttribute("aria-label", "送信する画像のプレビュー");
    panel.append(help, preview);

    function slider(name, value, min, max) {
      const label = document.createElement("label");
      const caption = document.createElement("span");
      caption.textContent = name;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.value = String(value);
      label.append(caption, input);
      panel.append(label);
      return input;
    }

    const top = slider("範囲の上端", INITIAL_TOP, 0, INITIAL_BOTTOM - 1);
    const bottom = slider("範囲の下端", INITIAL_BOTTOM, INITIAL_TOP + 1, 100);

    function draw() {
      const start = Number(top.value);
      const end = Number(bottom.value);
      top.max = String(end - 1);
      bottom.min = String(start + 1);
      top.setAttribute("aria-valuetext", `画像の上から${start}%`);
      bottom.setAttribute("aria-valuetext", `画像の上から${end}%`);
      drawCrop(image, preview, start, end);
    }
    draw();
    top.addEventListener("input", draw);
    bottom.addEventListener("input", draw);
    container.replaceChildren(panel);
    signal?.addEventListener("abort", () => {
      panel.remove();
      image.removeAttribute("src");
      preview.width = preview.height = 1;
    }, { once: true });
    return () => {
      if (signal?.aborted) throw abortError();
      return encode(preview);
    };
  }

  root.UberQuestImageCrop = { open, defaultJpeg };
})(window);
