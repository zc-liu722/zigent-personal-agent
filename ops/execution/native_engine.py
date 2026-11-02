"""Transport for the repository-built Zigent execution module inside a container."""
import base64
import json
import threading
import time


class NativeCommand:
    def __init__(self, process, process_id, output, maximum):
        self.process = process
        self.process_id = process_id
        self.output = output
        self.maximum = maximum
        self.total = 0
        self.serial = 0
        self.pending = {}
        self.condition = threading.Condition()
        self.write_lock = threading.Lock()
        self.failure = None
        threading.Thread(target=self.read, daemon=True).start()

    def send(self, value):
        with self.write_lock:
            self.process.stdin.write((json.dumps(value, separators=(',', ':')) + '\n').encode())
            self.process.stdin.flush()

    def request(self, method, params):
        with self.condition:
            self.serial += 1
            identifier = self.serial
            self.pending[identifier] = None
        self.send({'id': identifier, 'op': method, 'params': params})
        return identifier

    def wait(self, identifier, timeout=None):
        deadline = time.monotonic() + timeout if timeout is not None else None
        with self.condition:
            while self.pending.get(identifier) is None:
                if self.failure:
                    raise RuntimeError(self.failure)
                remaining = deadline - time.monotonic() if deadline is not None else None
                if remaining is not None and remaining <= 0:
                    raise RuntimeError('Execution module transport did not respond')
                self.condition.wait(remaining)
            response = self.pending.pop(identifier)
        if 'error' in response:
            raise RuntimeError('Execution module failed: ' + str(response['error'].get('message', 'unknown error'))[:1000])
        return response.get('result', {})

    def read(self):
        try:
            for line in self.process.stdout:
                value = json.loads(line)
                if value.get('event') == 'output':
                    data = base64.b64decode(value['data'], validate=True)
                    self.total += len(data)
                    if self.total > self.maximum:
                        raise RuntimeError('Program output exceeded its disk budget')
                    self.output.write(data)
                    self.output.flush()
                elif value.get('id') is not None:
                    with self.condition:
                        if value['id'] in self.pending:
                            self.pending[value['id']] = value
                        self.condition.notify_all()
            raise RuntimeError('Execution module transport closed; command was not replayed')
        except Exception as error:
            with self.condition:
                self.failure = str(error)[:1000]
                self.condition.notify_all()

    def start(self, request):
        shell = request.get('shell') or '/bin/bash'
        # Login shells can reset PATH; reassert only the packaged runtime paths.
        command = [shell, '-lc' if request.get('login', True) else '-c', 'export PATH=/opt/zigent-python/bin:/opt/zigent-file-runtime/node_modules/.bin:$PATH; ' + request['command']]
        self.command_id = self.request('start', {'command': command,
            'cwd': '/workspace' + ('/' + request['cwd'] if request['cwd'] else ''),
            'tty': request.get('tty', False), 'timeoutMs': request['timeoutMs'],
            'env': {'PATH': '/opt/zigent-python/bin:/opt/zigent-file-runtime/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                    'PYTHONPATH': '/opt/zigent-file-runtime', 'NODE_PATH': '/opt/zigent-file-runtime/node_modules',
                    **({'GIT_SSH_COMMAND':'ssh -F /run/zigent-github/config'} if request.get('github') else {})}})
        return self.command_id

    def write(self, text, tty=False):
        method='interrupt' if '\x03' in text and not tty else 'write'
        params={}
        if method == 'write':params['data']=base64.b64encode(text.encode()).decode()
        deadline=time.monotonic()+20
        while True:
            try:return self.wait(self.request(method,params),20)
            except RuntimeError as error:
                # Only this explicit server rejection guarantees no bytes were accepted.
                with self.condition:pending=self.pending.get(self.command_id) is None and self.command_id in self.pending
                if 'No active process' not in str(error) or not pending or time.monotonic()>=deadline:raise
                time.sleep(.05)
