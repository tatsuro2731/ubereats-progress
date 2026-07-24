from pathlib import Path


def replace_exact(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


def replace_in_test(path: str, marker: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    start = text.find(marker)
    if start < 0:
        raise RuntimeError(f"{path}: test marker not found: {marker}")
    end = text.find('\ntest("', start + len(marker))
    if end < 0:
        end = len(text)
    section = text[start:end]
    count = section.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one section match, found {count}: {old!r}")
    target.write_text(text[:start] + section.replace(old, new) + text[end:], encoding="utf-8")


replace_exact(
    "tests/delivery-contracts.test.js",
    "  assert.match(enhancements, /案件の有無や移動状態は自動判定しません/);",
    "  assert.match(enhancements, /案件の有無や端末の移動状態は自動判定しません/);",
)

replace_exact(
    "app-session-ui-fix.js",
    """    const remainingMs = Math.max(0, finite(clockState.remainingMs, finite(clockState.baseRemain) * 60000));
    const activeMs = clockUsedMs(remainingMs) + otherCompanyOverlapMs(timestamp, now);
    const elapsedMs = Math.max(0, now - timestamp - breakOverlapMs(timestamp, now));
    if (activeMs > elapsedMs) {
      error.textContent = \"開始時刻が遅すぎます。総実稼働時間より後には設定できません。\";
      return;
    }""",
    """    const remainingMs = Math.max(0, finite(clockState.remainingMs, finite(clockState.baseRemain) * 60000));
    const currentStartAt = finite(clockState.sessionStartAt, timestamp);
    const recordedOtherCompanyMs = otherCompanyOverlapMs(currentStartAt, now);
    const earliestOtherCompanyStartAt = (Array.isArray(clockState.otherCompanySegments) ? clockState.otherCompanySegments : []).reduce((earliest, segment) => {
      const startAt = finite(segment && segment.startAt, NaN);
      const rawEnd = segment && segment.endAt;
      const endAt = rawEnd === null || rawEnd === undefined ? now : finite(rawEnd, NaN);
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return earliest;
      return Math.min(earliest, Math.max(currentStartAt, startAt));
    }, Infinity);
    const activeMs = clockUsedMs(remainingMs) + recordedOtherCompanyMs;
    const elapsedMs = Math.max(0, now - timestamp - breakOverlapMs(timestamp, now));
    const startsAfterOtherCompanyWork = Number.isFinite(earliestOtherCompanyStartAt) && timestamp > earliestOtherCompanyStartAt;
    if (startsAfterOtherCompanyWork || activeMs > elapsedMs) {
      error.textContent = \"開始時刻が遅すぎます。総実稼働時間より後には設定できません。\";
      return;
    }""",
)

replace_in_test(
    "tests/timer-engine.test.js",
    'test("manual correction, open break, finish, and history keep one linked usage metric"',
    """  assert.equal(app.api.getState().activeMs, 150 * minute);
  app.api.toggleBreak();
  assert.equal(app.api.getState().breakOn, true);""",
    """  assert.equal(app.api.getState().activeMs, 150 * minute);
  app.api.enhancedToggleClock();
  assert.equal(app.api.getState().on, true);
  app.api.toggleBreak();
  assert.equal(app.api.getState().breakOn, true);""",
)

replace_in_test(
    "tests/timer-engine.test.js",
    'test("time ON shared control remains the break control and pauses Uber countdown"',
    """      sessionStartAt: now,
      lastTickAt: now,
      otherCompanyOn: false,""",
    """      sessionStartAt: now,
      lastTickAt: now,
      updatedAt: now,
      otherCompanyOn: false,""",
)

Path("contract-test-output.txt").unlink(missing_ok=True)
Path("pr-merge-test-output.txt").unlink(missing_ok=True)
