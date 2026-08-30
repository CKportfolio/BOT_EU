# Bezpieczeństwo

## Tryb LIVE

`BOT_MODE=LIVE` składa rzeczywiste zlecenia na giełdzie. Przed użyciem LIVE:

- uruchom i obserwuj strategię w `PAPER`,
- używaj osobnego klucza API przeznaczonego wyłącznie do handlu,
- nie nadawaj kluczowi uprawnień do wypłat,
- ogranicz uprawnienia do wymaganych funkcji Spot/Wallet,
- nie commituj pliku `.env`.

## Dane prywatne

Repozytorium celowo nie zawiera:

- kluczy API,
- historii rzeczywistych transakcji,
- sald konta,
- plików runtime state,
- logów LIVE/PAPER z lokalnych uruchomień.

## UI

Panel domyślnie powinien być wystawiony tylko lokalnie. Jeśli jest publikowany przez reverse proxy, należy użyć uwierzytelnienia oraz właściwej konfiguracji sieciowej.

## Disclaimer

Projekt ma charakter techniczny i edukacyjny. Nie stanowi rekomendacji inwestycyjnej ani gwarancji zysku.
