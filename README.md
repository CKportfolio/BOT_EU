# BOT EU — Grid Bot dla Bybit.eu

Automatyczny bot transakcyjny dla rynku **Spot Bybit.eu**, zbudowany jako projekt rozwijany iteracyjnie od symulacji PAPER do pracy z rzeczywistym API giełdy.

## Czym jest grid bot

Grid bot rozstawia serię zleceń limit po obu stronach aktualnej ceny:

- zlecenia **BUY** poniżej rynku,
- zlecenia **SELL** powyżej rynku.

Celem nie jest przewidywanie jednego dużego ruchu ceny, lecz wielokrotne wykorzystywanie mniejszych ruchów rynku: kupno niżej, sprzedaż wyżej i ponowne ustawienie przeciwnego zlecenia.

## Jak działa BOT EU

Po uruchomieniu bot:

1. pobiera aktualne dane rynku z Bybit.eu,
2. sprawdza parametry instrumentu i dostępność wskazanej pary,
3. uwzględnia rzeczywisty krok ceny i ilości wymagany przez giełdę,
4. pobiera aktualną stawkę prowizji,
5. buduje siatkę zleceń BUY i SELL,
6. obserwuje wykonania,
7. po wykonaniu zlecenia tworzy zlecenie przeciwne (`counter order`),
8. zapisuje stan i statystyki kolejnych zamkniętych pętli.

Silnik posiada także **fee guard** — minimalny odstęp poziomów uwzględnia koszt prowizji, aby siatka nie była ustawiona ciaśniej niż koszt pełnej pętli transakcji.

## Reinwestowanie

Kapitał pozostaje w obrocie.

Po wykonaniu zlecenia BUY bot wystawia wyżej odpowiadający mu SELL dla ilości pozostałej po prowizji.

Po wykonaniu SELL całość dostępnych środków z tej sprzedaży — po uwzględnieniu prowizji — jest przeznaczana na niższy counter BUY. W ten sposób kolejne cykle wykorzystują również środki wypracowane przez wcześniejsze pętle.

Bot osobno śledzi liczbę zamkniętych pętli oraz ich wynik w walucie kwotowanej.

## PAPER i LIVE

Bot posiada dwa podstawowe tryby:

### PAPER

Symulacja zleceń i salda bez składania rzeczywistych zleceń na giełdzie.

Służy do:

- testowania konfiguracji,
- obserwowania zachowania siatki,
- sprawdzania mechanizmu counter orders,
- pracy nad strategią bez ryzyka kapitału.

### LIVE

Tryb połączony z prywatnym API Bybit.eu.

Bot:

- pobiera saldo konta,
- synchronizuje czas z serwerem giełdy,
- pobiera parametry instrumentu,
- pobiera rzeczywiste fee,
- składa i anuluje zlecenia limit,
- odczytuje wykonane transakcje,
- odtwarza stan po restarcie.

`LIVE` wymaga własnych kluczy API w pliku `.env`.

## Obsługiwane pary

Para jest wybierana przez:

```env
BOT_MARKET=BTCUSDC
BOT_CATEGORY=spot
```

Kod nie jest przywiązany na stałe do BTC. Przy starcie sprawdza wskazany symbol przez Bybit.eu API oraz pobiera specyfikację instrumentu.

W praktyce można użyć **pary Spot dostępnej dla danego konta i endpointu Bybit.eu**, o ile jej symbol jest poprawnie rozpoznawany przez parser aplikacji.

Jeśli para nie jest dostępna, bot kończy start z czytelnym komunikatem zamiast próbować handlować nieistniejącym instrumentem.

## Poziomy wsparcia i oporu — stan obecnej wersji

Silnik `grid.js` posiada logikę pracy z **klastrami cenowymi** (`cluster_price`, `cluster_strength`) jako kotwicami dla poziomów poniżej i powyżej ceny. Mechanizm ten został zaprojektowany do zagęszczania i ważenia gridu wokół istotniejszych stref rynku.

W **tej konkretnej wersji repozytorium** aktywny `regrid` nie dostarcza jednak danych klastrowych do silnika (`clustersZoned` jest obecnie puste), dlatego bieżący build tworzy regularną drabinkę cenową wokół rynku.

To pozostaje przygotowanym elementem architektury, który wymaga ponownego podłączenia źródła klastrów, aby można go było uczciwie traktować jako aktywną funkcję strategii.

## Panel i obserwacja pracy

Projekt zawiera lokalny panel webowy pokazujący m.in.:

- aktualną cenę,
- tryb PAPER/LIVE,
- saldo wolne i zarezerwowane,
- aktywne BUY/SELL,
- liczbę filli,
- wynik zamkniętych pętli,
- logi pracy bota,
- historię rynku i wskaźniki obserwacyjne.

Miejsce na screenshot:

```text
screenshots/bot-ui.png
```

Po dodaniu pliku możesz odkomentować poniższą linię:

<!-- ![BOT EU — panel](screenshots/bot-ui.png) -->

## Technologie

- Node.js / JavaScript (ES modules)
- Bybit V5 REST API / Bybit.eu
- `axios`
- `bybit-api`
- `dotenv`
- HTML / JavaScript — lokalny panel operatorski
- Docker / Docker Compose
- zapis stanu i logów lokalnych
- Windows BAT + PowerShell dla wersji lokalnej

## Uruchomienie

### 1. Instalacja

```bash
npm install
```

### 2. Konfiguracja

Skopiuj:

```text
.env.example → .env
```

Na początek pozostaw:

```env
BOT_MODE=PAPER
```

### 3. Start

```bash
npm start
```

Na Windows można również użyć:

```text
run.bat
```

Do uruchomienia bota razem z panelem:

```text
UIrun.bat
```

## Docker

```bash
docker compose up --build
```

Konfiguracja jest pobierana z lokalnego `.env`, który nie jest wersjonowany przez Git.

## Struktura

```text
index.js
config.js

scripts/
├── bot.js                 # główna pętla i stan
├── grid.js                # budowa siatki
├── execution_paper.js     # symulacja PAPER
├── live.js                # Bybit.eu LIVE API
├── data.js                # dane rynkowe
├── symbols.js             # symbole i zaokrąglenia instrumentów
├── console_support.js     # sterowanie z konsoli
└── js/                    # panel i obserwacja rynku
```

## Quality gates

Repozytorium posiada automatyczny pipeline GitHub Actions uruchamiany dla pushy i Pull Requestów.

CI sprawdza:

- instalację zależności przez `npm ci`,
- składnię plików JavaScript,
- testy jednostkowe parsera symboli i zaokrągleń giełdowych,
- testy fee guard i budowy grida,
- testy pracy silnika gridowego z klastrami cenowymi,
- testy PAPER execution: rezerwacje, fill BUY/SELL, fee i anulowanie zleceń,
- podatności zależności `high/critical` przez `npm audit`,
- możliwość zbudowania produkcyjnego obrazu Docker.

Testy CI **nie używają kluczy API i nie składają rzeczywistych zleceń**. `LIVE` pozostaje poza automatycznym pipeline.

Lokalnie:

```bash
npm test
npm run check:syntax
```

## License

Kod jest publicznie dostępny do celów portfolio, edukacyjnych i technicznego review. Szczegóły: [LICENSE](LICENSE).

## Status

**Portfolio / active development project**

Repozytorium jest oczyszczoną wersją źródłową. Lokalne logi transakcyjne, runtime state, klucze API oraz duże historyczne artefakty testowe nie są publikowane.

> Projekt nie stanowi rekomendacji inwestycyjnej. Tryb LIVE wykonuje rzeczywiste operacje na giełdzie i wymaga świadomej konfiguracji.
