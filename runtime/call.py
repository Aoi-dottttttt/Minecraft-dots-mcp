#!/usr/bin/env python3
# Modified for the public-candidate release; see RELEASE.md.
# Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
"""Send one bounded command to the selected fresh private session. No retry."""
import argparse, json, os, pathlib, re, stat, sys, time, uuid
p=argparse.ArgumentParser();p.add_argument('--state-dir',required=True);p.add_argument('--timeout',type=float,default=200);p.add_argument('tool');p.add_argument('arguments',nargs='?',default='{}');a=p.parse_args()
os.umask(0o077)
if not 1<=a.timeout<=240:p.error('--timeout must be 1..240 seconds')
b=pathlib.Path(a.state_dir).expanduser().absolute()
def private_directory(path):
 for component in (path,*path.parents):
  if component.is_symlink():raise RuntimeError('Symlinked state directory rejected')
 if not path.is_dir() or path.stat().st_uid!=os.getuid() or stat.S_IMODE(path.stat().st_mode)&0o077:raise RuntimeError('State directory must be private and user-owned')
def read(path):
 st=path.lstat()
 if path.is_symlink() or not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077:raise RuntimeError('State file must be private, regular and user-owned')
 if st.st_size>1048576:raise RuntimeError('State file too large')
 return json.loads(path.read_text())
private_directory(b)
if (b/'active-session.json').exists():
 active=read(b/'active-session.json');sid=active.get('sessionId','')
 if not sid.startswith('session-') or '/' in sid or '..' in sid:raise RuntimeError('Invalid session reference')
 b=b/'sessions'/sid
 private_directory(b)
if (b/'current-controller.json').exists():
 reference=read(b/'current-controller.json');cid=reference.get('controllerId','')
 if not re.fullmatch(r'controller-[a-f0-9]{32}',cid):raise RuntimeError('Invalid controller reference')
 b=b/'controllers'/cid
 private_directory(b)
sid=b.name
if (b/'closed.json').exists():raise RuntimeError('Controller is closed; attach a fresh controller without replaying old queues')
if (b/'uncertain.json').exists():raise RuntimeError('An action outcome is uncertain; inspect existing reports instead of enqueuing another command')
session=read(b/'session.json')
if session.get('sessionId')!=sid or session.get('state')!='mcp_connected':raise RuntimeError('Session is not accepting commands')
args=json.loads(a.arguments)
if not isinstance(args,dict):p.error('arguments must be a JSON object')
if a.tool not in {t['name'] for t in read(b/'tools.json')['tools']}:p.error('unknown tool')
created_at=int(time.time()*1000)
i=str(created_at)+'-'+uuid.uuid4().hex[:16]+'.json'
payload=json.dumps({'name':a.tool,'arguments':args,'sessionId':sid,'createdAt':created_at},ensure_ascii=False)
if len(payload.encode())>65536:p.error('command exceeds 64 KiB')
q=b/'commands'
if not q.is_dir() or q.is_symlink():raise RuntimeError('Invalid command directory')
t=q/(i+'.tmp');f=q/i
with open(t,'x') as out:out.write(payload)
t.replace(f)
r=b/'responses'/i
end=time.monotonic()+a.timeout
while time.monotonic()<end:
 if r.exists():
  d=read(r);result=d.get('result',d)
  print(json.dumps(result,ensure_ascii=False,indent=2));sys.exit(1 if result.get('isError') or result.get('error') else 0)
 if (b/'closed.json').exists():
  print(json.dumps({'id':i,'uncertain':True,'sessionClosed':True,'automaticRetry':False}));sys.exit(2)
 time.sleep(.2)
print(json.dumps({'id':i,'pending':True,'automaticRetry':False,'message':'Check this same request response; do not enqueue a duplicate.'}));sys.exit(2)
