// 開発用プレビュー専用。GitHub Pages では従来どおり静的ファイルを配信する。
export default {
  appType: 'mpa',
  server: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: ['terminal.local'],
  },
};
