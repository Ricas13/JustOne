import unittest

from app import app


class CatalogueApiSurfaceTests(unittest.TestCase):
    def test_catalogue_service_exposes_no_media_routes(self):
        paths = {route.path for route in app.routes}

        self.assertIn("/health", paths)
        self.assertIn("/channels", paths)
        self.assertIn("/playlist.m3u8", paths)
        self.assertFalse(any(path.startswith("/stream/") for path in paths))
        self.assertFalse(any(path.startswith("/hls/") for path in paths))


if __name__ == "__main__":
    unittest.main()
