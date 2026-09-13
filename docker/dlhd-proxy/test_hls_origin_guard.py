import unittest

from app import _empty_media_playlist, _origin_from_referer


class HLSOriginGuardTests(unittest.TestCase):
    def test_origin_is_derived_from_http_referer(self):
        self.assertEqual(
            _origin_from_referer("https://player.example/path/embed?id=1"),
            "https://player.example",
        )
        self.assertEqual(
            _origin_from_referer("http://player.example:8080/path"),
            "http://player.example:8080",
        )

    def test_invalid_referer_does_not_create_origin(self):
        self.assertEqual(_origin_from_referer("player.example/path"), "")
        self.assertEqual(_origin_from_referer(""), "")

    def test_media_playlist_with_durations_but_no_uris_is_rejected(self):
        payload = """#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:4.000,
#EXTINF:4.000,
"""
        self.assertTrue(_empty_media_playlist(payload))

    def test_normal_media_playlist_is_not_empty(self):
        payload = """#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.000,
segment-10.ts
#EXTINF:4.000,
segment-11.ts
"""
        self.assertFalse(_empty_media_playlist(payload))

    def test_master_playlist_is_not_treated_as_empty_media_playlist(self):
        payload = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000
tracks-v1/mono.m3u8
"""
        self.assertFalse(_empty_media_playlist(payload))


if __name__ == "__main__":
    unittest.main()
