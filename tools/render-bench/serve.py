# Serveur du banc de rendu : racine = projet, /api/ui/plugins/growth-studio/media/N -> médias copiés. Arrêt par timeout.
import http.server, os, re, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def translate_path(s, path):
        m = re.match(r'/api/ui/plugins/growth-studio/media/(\d+)', path)
        if m: return os.path.join(ROOT, 'tools/render-bench/api/ui/plugins/growth-studio/media', m.group(1))
        return super().translate_path(path)
    def guess_type(s, path): return 'image/png' if '/media/' in path else super().guess_type(path)
    def log_message(s, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
