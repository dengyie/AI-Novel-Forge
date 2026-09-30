#!/usr/bin/env python3
"""Exercise the shipped nginx config against an isolated upstream, never production data."""
import argparse
import http.client
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

MIB = 1024 * 1024


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def header_status(port, path, size):
    # Send no body: oversized known lengths must fail before buffering/uploading.
    with socket.create_connection(('127.0.0.1', port), timeout=5) as sock:
        sock.sendall((f'POST {path} HTTP/1.1\r\nHost: upload.test\r\n'
                      f'Content-Length: {size}\r\nContent-Type: image/png\r\n'
                      'Expect: 100-continue\r\nConnection: close\r\n\r\n').encode())
        line = sock.makefile('rb').readline().decode().strip()
        return int(line.split()[1])


def request(port, path, body, chunked=False):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        conn.request('POST', path, body, headers={
            'Host': 'upload.test', 'Content-Type': 'image/png',
            'X-Forwarded-For': '192.0.2.4',
        }, encode_chunked=chunked)
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        conn.close()


def check_equal(actual, expected, label):
    assert actual == expected, f'{label}: expected {expected!r}, got {actual!r}'
    print(f'PASS {label}', flush=True)


def run_checks(port):
    paths = [
        '/api/comic/character-assets/test/upload-image',
        '/api/comic/scenes/test/upload-image',
        '/api/comic/scenes/test/upload-image/?source=test',
        '/api/COMIC/SCENES/test/UPLOAD-IMAGE',
    ]
    for path in paths:
        check_equal(header_status(port, path, 10 * MIB + 1), 413, f'early limit {path}')
        check_equal(header_status(port, path, 10 * MIB), 100, f'inclusive limit {path}')
    for path in paths[:2]:
        status, _, body = request(port, path + '?source=test', b'image-probe')
        check_equal(status, 200, f'proxy {path}')
        forwarded = json.loads(body)
        check_equal(forwarded['uri'], path + '?source=test', 'URI preserved')
        check_equal(forwarded['host'], 'upload.test', 'Host inherited')
        assert forwarded['xff'].startswith('192.0.2.4, '), forwarded
        assert forwarded['realIp'], forwarded
        check_equal(forwarded['proto'], 'http', 'proxy headers inherited')
        check_equal(request(port, path, b'x' * (10 * MIB))[0], 200, 'full boundary body accepted')
        status, _, body = request(port, path, iter([b'x' * MIB] * 10 + [b'x']), chunked=True)
        check_equal(status, 413, 'cumulative chunked limit')
        assert '10 MiB' in json.loads(body)['error']
        # A declared oversized chunk plus one byte triggers parsing without a full upload.
        with socket.create_connection(('127.0.0.1', port), timeout=5) as sock:
            sock.sendall((f'POST {path} HTTP/1.1\r\nHost: upload.test\r\n'
                          'Transfer-Encoding: chunked\r\nContent-Type: image/png\r\n'
                          f'Connection: close\r\n\r\n{10 * MIB + 1:x}\r\nx').encode())
            response = http.client.HTTPResponse(sock)
            response.begin()
            check_equal(response.status, 413, f'chunk limit {path}')
            check_equal(response.getheader('Content-Type'), 'application/json', 'JSON content type')
            check_equal(response.getheader('X-Content-Type-Options'), 'nosniff', 'security header inherited')
            error = json.loads(response.read())
            check_equal(error['success'], False, 'API error contract')
            assert '10 MiB' in error['error'], error
    for path in ['/api/other', '/api/comic/scenes/test/generate-image',
                 '/api/comic/scenes/test/upload-image/extra']:
        check_equal(header_status(port, path, 11 * MIB), 100, f'other API unaffected {path}')
        check_equal(header_status(port, path, 20 * MIB + 1), 413, f'general limit {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='nginxinc/nginx-unprivileged:1.27-alpine')
    parser.add_argument('--config', type=Path, default=Path('infra/nginx/ai-novel-web.conf'))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='ainovel-nginx-test-') as temp:
        directory = Path(temp)
        directory.chmod(0o755)
        shutil.copyfile(args.config, directory / 'default.conf')
        (directory / 'upstream.conf').write_text('''server {
    listen 3000;
    client_max_body_size 20m;
    location / {
        default_type application/json;
        return 200 '{"uri":"$request_uri","host":"$http_host","xff":"$http_x_forwarded_for","realIp":"$http_x_real_ip","proto":"$http_x_forwarded_proto"}';
    }
}
''')
        container = None
        try:
            container = docker('run', '--rm', '-d', '--add-host', 'api:127.0.0.1',
                               '-p', '127.0.0.1::8080', '-v', f'{directory}:/etc/nginx/conf.d:ro', args.image)
            docker('exec', container, 'nginx', '-t')
            port = int(docker('port', container, '8080/tcp').split(':')[-1])
            for attempt in range(50):
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=1):
                        break
                except OSError:
                    if attempt == 49:
                        raise
                    time.sleep(0.1)
            run_checks(port)
        finally:
            if container:
                docker('stop', '--time', '2', container)


if __name__ == '__main__':
    main()
