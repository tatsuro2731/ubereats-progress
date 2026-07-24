from pathlib import Path

path = Path("tests/delivery-contracts.test.js")
text = path.read_text(encoding="utf-8")
old = "  assert.match(enhancements, /clockUsedMs\\(\\)\\s*\\/\\s*elapsed\\s*\\*\\s*100/);"
new = "\n".join([
    "  assert.match(enhancements, /clockUsedMs\\(\\)\\s*\\+\\s*otherCompanyDurationMs\\(at\\)/);",
    "  assert.match(enhancements, /totalActiveMs\\(at\\)\\s*\\/\\s*elapsed\\s*\\*\\s*100/);",
    "  assert.match(enhancements, /sharedMode\\s*=\\s*clockState\\.on\\s*\\?\\s*[\"']break[\"']\\s*:\\s*[\"']otherCompany[\"']/);",
])
count = text.count(old)
if count != 1:
    raise RuntimeError(f"expected one legacy rate contract, found {count}")
path.write_text(text.replace(old, new), encoding="utf-8")
Path("pr-merge-test-output.txt").unlink(missing_ok=True)
