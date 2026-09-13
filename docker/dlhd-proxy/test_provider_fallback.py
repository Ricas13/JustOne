import unittest

from provider import Channel, Provider, parse_channels


class CatalogueTests(unittest.TestCase):
    def test_parses_unique_channels_and_preserves_duplicate_names(self):
        html = """
        <a href="/watch.php?id=54"><div class="card__title">BBC One UK</div></a>
        <a href="/watch.php?id=55"><div class="card__title">BBC One UK</div></a>
        <a href="/watch.php?id=54"><div class="card__title">Duplicate row</div></a>
        <a href='/watch.php?id=70'><div class='card__title'>RTP 1 # Portugal</div></a>
        """

        channels = parse_channels(html)
        self.assertEqual([channel.id for channel in channels], ["54", "55", "70"])
        self.assertEqual([channel.name for channel in channels], ["BBC One UK", "BBC One UK", "RTP 1  Portugal"])

    def test_playback_url_is_provider_page_for_easyproxy(self):
        provider = Provider.__new__(Provider)
        url = provider.playback_url(Channel(id="123", name="Example"))

        self.assertIn("watch.php?id=123", url)
        self.assertNotIn("/stream/123", url)
        self.assertNotIn("localhost", url)


if __name__ == "__main__":
    unittest.main()
