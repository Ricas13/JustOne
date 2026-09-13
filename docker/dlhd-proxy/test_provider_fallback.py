import unittest

from provider import Channel, Provider, parse_channels
from settings import settings


class FakeResponse:
    def __init__(self, status_code=200, text=""):
        self.status_code = status_code
        self.text = text


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


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
        self.assertEqual([channel.name for channel in channels], ["BBC One UK", "BBC One UK", "RTP 1 Portugal"])

    def test_parser_decodes_entities_nested_markup_and_whitespace(self):
        html = """
        <a href="/watch.php?id=81">
          <div class="featured card__title active">Sport &amp; News <span>HD</span></div>
        </a>
        <a href='/watch.php?id=82'><div class='card__title'>  RTP&nbsp;2   Portugal  </div></a>
        """
        channels = parse_channels(html)
        self.assertEqual(
            [(channel.id, channel.name) for channel in channels],
            [("81", "Sport & News HD"), ("82", "RTP\xa02 Portugal")],
        )

    def test_parser_returns_empty_for_unrecognised_markup(self):
        self.assertEqual(parse_channels("<html><body>maintenance</body></html>"), [])

    def test_playback_url_is_exact_provider_page_for_easyproxy(self):
        provider = Provider.__new__(Provider)
        url = provider.playback_url(Channel(id="123", name="Example"))

        self.assertEqual(url, f"{settings.playback_base_url}/watch.php?id=123")
        self.assertNotIn("/stream/123", url)
        self.assertNotIn("localhost", url)


class CatalogueRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_provider_page_is_rejected_instead_of_clearing_catalogue(self):
        provider = Provider.__new__(Provider)
        provider._session = FakeSession(FakeResponse(200, "<html>maintenance</html>"))
        provider.channels = [Channel(id="1", name="Last good")]

        with self.assertRaisesRegex(ValueError, "no supported rows"):
            await provider.load_channels()

        self.assertEqual(provider.channels, [Channel(id="1", name="Last good")])

    async def test_http_failure_is_rejected_without_replacing_last_good_catalogue(self):
        provider = Provider.__new__(Provider)
        provider._session = FakeSession(FakeResponse(503, "unavailable"))
        provider.channels = [Channel(id="1", name="Last good")]

        with self.assertRaisesRegex(ValueError, "HTTP 503"):
            await provider.load_channels()

        self.assertEqual(provider.channels, [Channel(id="1", name="Last good")])


if __name__ == "__main__":
    unittest.main()
