# Channel ordering

JustOne keeps the top-level lineup in this order:

1. UK
2. Portugal
3. USA
4. DLHD events grouped by sport/type

Static channels inside each country are ordered using a real TV-provider lineup rather than alphabetically.

## UK

Primary order: **Sky TV UK (England)**.

JustOne uses the Sky TV England lineup as a broad baseline and overlays current Sky Glass/Stream positions for the main entertainment, movie, sports, news and kids channels.

Examples:

- BBC One before BBC Two, ITV1, Channel 4 and Channel 5
- BBC Three/Four in their Sky positions
- Sky Cinema channels together in Sky order
- Sky Sports Main Event through Sky Sports Mix in Sky order
- TNT Sports 1-4 directly after the Sky Sports block

## Portugal

Primary order: **MEO**.

The familiar MEO order is preserved, starting RTP 1, RTP 2, SIC, TVI, then Portuguese news/general channels and the sports block. Legacy Eleven Sports names occupy their DAZN successor positions.

## USA

Primary order: **DIRECTV Premier**, with New York local channels anchored to their local channel positions because the DLHD USA catalogue includes the New York affiliates.

There is no single universal US channel numbering plan. JustOne therefore uses one consistent national provider rather than mixing Comcast, Spectrum, DISH and DIRECTV positions.

## Fallback behaviour

A provider position is only a sort key. JustOne continues to assign its own non-colliding output numbers:

- UK: `1000+`
- Portugal: `2000+`
- USA: `3000+`
- Events: `90000+`

This preserves stable country blocks even where providers reuse channel numbers. Channels not found in the provider-order reference are retained and sorted alphabetically at the end of their own country block.

Remote UK/US provider-lineup data is cached under `/data/provider-order-cache.json` for 24 hours. A fetch failure never breaks a catalogue refresh: JustOne uses the cached lineup where available and otherwise falls back to its built-in current anchors.
