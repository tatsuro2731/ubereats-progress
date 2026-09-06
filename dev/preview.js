const appFrame = document.getElementById('app-preview');
const compactFrame = document.getElementById('compact-preview');
const widthControl = document.getElementById('preview-width');
const heightControl = document.getElementById('preview-height');
const compactControl = document.getElementById('show-compact');

// 公開サイト上で実際の保存データを使った確認を始めない。
const developmentHost = ['terminal.local', 'localhost', '127.0.0.1'].includes(location.hostname);
if (developmentHost) {
  appFrame.src = '../index.html';
  const resize = () => {
    for (const frame of [appFrame, compactFrame]) {
      frame.style.width = `${widthControl.value}px`;
      frame.style.height = `${heightControl.value}px`;
    }
  };
  widthControl.addEventListener('change', resize);
  heightControl.addEventListener('change', resize);
  compactControl.addEventListener('change', () => {
    compactFrame.hidden = !compactControl.checked;
    if (compactControl.checked && !compactFrame.hasAttribute('src')) {
      compactFrame.src = '../compact.html';
    }
  });
  resize();
} else {
  appFrame.hidden = true;
  for (const control of [widthControl, heightControl, compactControl]) control.disabled = true;
  document.getElementById('preview-note').textContent = 'この確認画面は開発用サーバーでのみ利用できます。';
}
