# Test-only TLS material

`ca.pem` is a throwaway CA and `server.pem` / `server.key` a certificate it
signed for `127.0.0.1` and `localhost`, valid for a hundred years. They exist
so the WebQuery tests can run an HTTPS server. The key protects nothing and
must never be used anywhere else. The CA's own key was discarded.
