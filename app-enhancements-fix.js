(() => {
  "use strict";
  const resetButton = document.getElementById("reset");
  if (!resetButton) return;

  resetButton.onclick = () => {
    if (!confirm("完了件数・残り時間・終了上限・今日の稼働計測をリセットしますか？")) return;

    if (clockState && clockState.on && document.getElementById("countToggle")) {
      document.getElementById("countToggle").click();
    }

    document.getElementById("done").value = "0";
    document.getElementById("remainH").value = "12";
    document.getElementById("remainM").value = "0";
    document.getElementById("endLimit").value = "";

    const now = Date.now();
    clockState = {
      on: false,
      remainingMs: 720 * 60000,
      baseRemain: 720,
      baseAt: now,
      lastTickAt: now,
      moving: false,
      activeMs: 0,
      sessionStartAt: null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      updatedAt: now
    };

    localStorage.setItem("ubereatsProgressMovementClockV1", JSON.stringify({
      on: false,
      remainingMs: 720 * 60000,
      activeMs: 0,
      sessionStartAt: null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      updatedAt: now
    }));
    localStorage.setItem(CLOCK_KEY, JSON.stringify({ on: false, baseRemain: 720, baseAt: now }));
    save();
    calc();
  };
})();
