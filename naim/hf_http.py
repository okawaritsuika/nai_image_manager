"""Verified public Hugging Face connections without inherited TLS key logging."""
import ssl

import requests
from requests.adapters import HTTPAdapter


class _VerifiedHTTPSAdapter(HTTPAdapter):
    def __init__(self):
        # Default context helpers read SSLKEYLOGFILE, which can point to a
        # removed directory in a packaged app. Never change process-wide env.
        self._ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self._ssl_context.minimum_version = ssl.TLSVersion.TLSv1_2
        self._ssl_context.hostname_checks_common_name = False
        self._ssl_context.load_verify_locations(requests.certs.where())
        super().__init__()

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        pool_kwargs['ssl_context'] = self._ssl_context
        return super().init_poolmanager(connections, maxsize, block=block, **pool_kwargs)

    def build_connection_pool_key_attributes(self, request, verify, cert=None):
        # Requests versions with a preloaded context must also retain ours.
        host, pool_kwargs = super().build_connection_pool_key_attributes(request, verify, cert)
        if verify is True:
            pool_kwargs['ssl_context'] = self._ssl_context
        return host, pool_kwargs


def public_session():
    session = requests.Session()
    # Public archives must never inherit .netrc credentials or local proxies.
    session.trust_env = False
    session.mount('https://', _VerifiedHTTPSAdapter())
    return session
