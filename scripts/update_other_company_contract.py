from pathlib import Path


def replace_exact(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


replace_exact(
    "tests/delivery-contracts.test.js",
    "  assert.match(enhancements, /案件の有無や端末の移動状態は自動判定しません/);",
    "  assert.match(enhancements, /Uber側の時計が進む時は時間ONにし/);",
)

replace_exact(
    "app-session-ui-fix.js",
    """    if (!clockState || !clockState.sessionStartAt || clockState.sessionEndedAt) {
      closeEditor();
      return;
    }
    const timestamp = parseLocalInput(input.value);""",
    """    if (!clockState || !clockState.sessionStartAt || clockState.sessionEndedAt) {
      closeEditor();
      return;
    }
    error.textContent = "";
    const timestamp = parseLocalInput(input.value);""",
)

Path("contract-test-output.txt").unlink(missing_ok=True)
Path("pr-merge-test-output.txt").unlink(missing_ok=True)
