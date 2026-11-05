# Stav analytického jádra

Dokument popisuje, co umí výpočty v `src/analysis` k datu poslední úpravy diagnostiky. Není to právní výklad nařízení a není to seznam přestupků.

## Hotové moduly

- `restIntervals.ts` skládá souvislé odpočinky ze stejného slotu. Neznámý úsek odpočinkem není.
- `restCandidates.ts` dává každému souvislému odpočinku délkové role. Role není právní potvrzení.
- `restWindowIntersection.ts` počítá průnik jednoho odpočinku se zadaným 24hodinovým oknem.
- `dailyRestOptions.ts` vrací délkové varianty denního odpočinku v jednom okně a žádnou nevolí.
- `dailyRestChain.ts` navazuje 24hodinová období od explicitní kotvy. Další kotva je skutečný konec odpočinku.
- `weeklyRest.ts` klasifikuje týdenní délku a posoudí jen explicitně vybrané odpočinky.
- `analyzeDriverActivities.ts` složí tyto kroky z původních `DriverCardData.activities`.
- `diagnosticCases.ts` z výsledku vybere případy k prověření.

## Podporované typy výsledků

Diagnostika používá čtyři stavy:

- `recorded_fact` je údaj z karty nebo přesně spočtená délka.
- `multiple_interpretations` znamená, že jedno okno má více denních variant.
- `insufficient_data` znamená chybějící kotvu, chybějící týdenní výběr, neznámý úsek nebo neprokázanou souvislost.
- `not_implemented` je pravidlo, které jádro záměrně ještě nepočítá.

Délková třída `regular` a `reduced` není stav `recorded_fact` ve smyslu právně potvrzeného odpočinku. Souhrn délek to říká výslovně.

## Známá omezení

- Denní návaznost se spustí jen po zadání kotvy v UTC. První záznam karty kotvou není.
- Týdenní posouzení se spustí jen po explicitním výběru odpočinků a dodání kalendáře týdnů. Rozhraní výběr zatím nezadává, proto panel ukazuje chybějící výběr.
- Odpočinek přes dva týdny patří jen jednomu z nich. Výběr týdne dělá volající, ne automat.
- Čítač zkrácených denních odpočinků se uzavře jen mezi dvěma použitelnými týdenními předěly a úplnou denní návazností.
- Ruční odpočinek zůstává zaznamenaným odpočinkem.
- Výpis případů nesmí mít položku pro každý běžný odpočinek. Při velkém počtu neznámých úseků, nejednoznačných překryvů nebo rozvětvených oken se zbytek shrne.
- Poznámka k případu žije jen v otevřené relaci a odchází s exportem JSON. Export neobsahuje jméno, číslo karty ani surový soubor DDD.

## Dosud neimplementovaná pravidla

- přestupky a závěr o souladu,
- dvě po sobě jdoucí kalendářní týdny,
- zvláštní režim mezinárodní nákladní dopravy mimo stát usazení,
- skutečné čerpání kompenzace zkráceného týdenního odpočinku,
- vícečlenná osádka a příležitostná osobní doprava,
- automatické generování větví „použít nebo nepoužít“ u týdenního odpočinku.

## Doporučené další kroky

1. V panelu umožnit explicitní výběr týdenního kandidáta a zadání `WeekClock` bez automatické volby.
2. Uzavírat počet zkrácených denních odpočinků až ve chvíli, kdy jsou oba týdenní předěly vybrané.
3. Teprve potom doplnit pravidlo dvou po sobě jdoucích týdnů.
4. Kompenzaci zatím jen evidovat. Párování s jiným odpočinkem nechat na pozdější krok.
5. Přestupky přidat až jako samostatnou vrstvu nad dokončenými pravidly.
