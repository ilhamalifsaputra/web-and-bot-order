from pathlib import Path
import re

data = Path('.review-full-tests.log').read_bytes()
log = data.decode('utf-16' if data[:2] == b'\xff\xfe' else 'utf8', errors='replace')
log = re.sub(r'\x1b\[[0-9;]*m', '', log)
files = re.findall(r'^\s*\u2713 (\S+\.test\.tsx?) \((\d+) tests?', log, re.M)
failures = re.findall(r'^\s*[\u276f\u00d7] (\S+\.test\.tsx?)', log, re.M)
print(f'Passing files: {len(files)}; listed tests: {sum(int(n) for _, n in files)}; failure-marked files: {failures[-8:]}')
print(f'Recent file: {files[-1:]}; output bytes: {len(data)}')
