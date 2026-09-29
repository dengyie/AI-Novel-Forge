# MiMo HTTP adapter

Owns one HTTP request, timeout/cancellation cleanup, status preservation and audio response decoding.
The audiobook provider owns transport selection, retry/backoff, circuit state and product input construction.
Consume through this directory facade; do not import the provider from this adapter.
