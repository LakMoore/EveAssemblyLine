"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, Search } from "lucide-react";
import EveAuthorizationWarning from "@/components/EveAuthorizationWarning";
import TypeSearch, { type TypeSearchResult } from "@/components/TypeSearch";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  loadClientSession,
  refreshClientSession,
  type ClientSession,
} from "@/lib/client/requestCache";
import {
  calculateMarketTaxes,
  marketHubStandings,
  playerStructureSccSurchargeRate,
  taxPriceResponseSchema,
  tradingFeeRates,
  type TaxPriceResponse,
  type TaxScenario,
} from "@/lib/market/taxes";
import { globalPlexMarket, marketHubs, type MarketHubId } from "@/lib/reference/marketHubs";
import { useAppLanguage } from "../AppShell";

const accountingSkillId = 16622;
const brokerRelationsSkillId = 3446;
const quantityLimit = 1_000_000_000_000;
const skillPresets = [
  { value: "all-zero", label: "All zero", level: 0 },
  { value: "all-iv", label: "All IV", level: 4 },
  { value: "all-v", label: "All V", level: 5 },
];

/** Formats a wallet value in ISK, preserving unavailable prices. */
function isk(value: number | null, maximumFractionDigits = 2, minimumFractionDigits = 2): string {
  return value === null
    ? "Unavailable"
    : `${new Intl.NumberFormat(undefined, { minimumFractionDigits, maximumFractionDigits }).format(value)} ISK`;
}

/** Formats a rate with optional fixed decimal places, preserving full precision for calculations. */
function percent(value: number, decimalPlaces?: number): string {
  return `${new Intl.NumberFormat(
    undefined,
    {
      minimumFractionDigits: decimalPlaces ?? 0,
      maximumFractionDigits: decimalPlaces ?? 4,
    },
  ).format(value * 100)}%`;
}

/** Subscribes to cached character skills/standings without making secured ESI requests. */
function useTradingSession() {
  const [session, setSession] = useState<ClientSession | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let generation = 0;
    /** Prevents an older session load from replacing a newer authentication state. */
    function load(refresh: boolean) {
      const requestedGeneration = ++generation;
      void (refresh ? refreshClientSession() : loadClientSession())
        .then((loaded) => {
          if (!active || requestedGeneration !== generation) return;
          setSession(loaded);
          setError("");
        })
        .catch(() => {
          if (!active || requestedGeneration !== generation) return;
          setSession({ authenticated: false });
          setError(
            "Character skills and standings could not be loaded. Skill presets remain available.",
          );
        });
    }
    /** Reloads the safe session projection after character refresh or authentication changes. */
    function reload() {
      load(true);
    }
    /** Clears private character options only when authentication itself changes. */
    function reloadAuthentication() {
      setSession(null);
      load(true);
    }
    load(false);
    window.addEventListener("assembly-line-auth-changed", reloadAuthentication);
    window.addEventListener("assembly-line-esi-refreshed", reload);
    return () => {
      active = false;
      window.removeEventListener("assembly-line-auth-changed", reloadAuthentication);
      window.removeEventListener("assembly-line-esi-refreshed", reload);
    };
  }, []);
  return { session, error };
}

/** Displays one price scenario with separately itemized taxes, fees and wallet movement. */
function ScenarioCard({
  title,
  priceLabel,
  result,
  selling,
  brokerRate,
  salesTaxRate,
  sccSurchargeRate,
}: {
  title: string;
  priceLabel: string;
  result: TaxScenario | null;
  selling: boolean;
  brokerRate: number;
  salesTaxRate: number;
  sccSurchargeRate?: number;
}) {
  const rows = [
    [priceLabel, result ? isk(result.unitPrice) : "Unavailable"],
    ["Order value", result ? isk(result.gross) : "Unavailable"],
    [`Broker fee (${percent(brokerRate, 2)})`, result ? isk(result.brokerFee) : "Unavailable"],
    ...(sccSurchargeRate === undefined
      ? []
      : [
          [
            `SCC Surcharge (${percent(sccSurchargeRate)})`,
            result ? isk(result.sccSurcharge) : "Unavailable",
          ],
        ]),
    [`Sales tax (${percent(salesTaxRate)})`, result ? isk(result.salesTax) : "Unavailable"],
  ];
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{selling ? "Selling" : "Buying"}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt>{label}</dt>
              <dd className="min-w-0 wrap-break-word">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
      <CardFooter className="mt-auto flex flex-wrap justify-between gap-2">
        <span>{selling ? "I receive" : "I will pay"}</span>
        <strong className="min-w-0 wrap-break-word">
          {result ? isk(result.total) : "Unavailable"}
        </strong>
      </CardFooter>
    </Card>
  );
}

/** Compares NPC-hub market transactions using cached character skills and client-side quantities. */
export default function TaxesPage() {
  const { language } = useAppLanguage();
  const { session, error: sessionError } = useTradingSession();
  const [selectedType, setSelectedType] = useState<TypeSearchResult | null>(null);
  const [marketId, setMarketId] = useState<MarketHubId>("jita");
  const [skillProfile, setSkillProfile] = useState("all-zero");
  const [quantityInput, setQuantityInput] = useState("1");
  const [createBuyOrdersInPlayerStructure, setCreateBuyOrdersInPlayerStructure] = useState(false);
  const [ownerBrokerFeeInput, setOwnerBrokerFeeInput] = useState("0");
  const [factionInput, setFactionInput] = useState("0");
  const [corporationInput, setCorporationInput] = useState("0");
  const [quote, setQuote] = useState<TaxPriceResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const activeRequest = useRef<AbortController | null>(null);
  const quantity = Number(quantityInput);
  const validQuantity =
    Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= quantityLimit;
  const usesCharacter = skillProfile.startsWith("character:");
  const selectedCharacter = session?.characters?.find(
    (character) => `character:${character.characterId}` === skillProfile,
  );
  const selectedHub = marketHubs.find((hub) => hub.id === marketId);
  const standingsSnapshot = selectedCharacter?.standings;
  const needsStandingsAuthorization =
    usesCharacter
    && (
      selectedCharacter?.standingsAuthorized === false
      || standingsSnapshot?.reauthorizeRequired === true
    );
  const characterStandings =
    selectedCharacter?.standingsAuthorized === true
    && !needsStandingsAuthorization
    && standingsSnapshot?.hasBody === true
      ? marketHubStandings(standingsSnapshot.body, marketId)
      : null;
  const factionValue = usesCharacter
    ? characterStandings
      ? String(characterStandings.factionStanding)
      : ""
    : factionInput;
  const corporationValue = usesCharacter
    ? characterStandings
      ? String(characterStandings.corporationStanding)
      : ""
    : corporationInput;
  const factionStanding = Number(factionValue);
  const corporationStanding = Number(corporationValue);
  const validFactionStanding =
    factionValue.trim() !== ""
    && Number.isFinite(factionStanding)
    && Math.abs(factionStanding) <= 10;
  const validCorporationStanding =
    corporationValue.trim() !== ""
    && Number.isFinite(corporationStanding)
    && Math.abs(corporationStanding) <= 10;
  const validStandings = validFactionStanding && validCorporationStanding;
  const ownerBrokerFeePercent = Number(ownerBrokerFeeInput);
  const validOwnerBrokerFee =
    !createBuyOrdersInPlayerStructure
    || (
      ownerBrokerFeeInput.trim() !== ""
      && Number.isFinite(ownerBrokerFeePercent)
      && ownerBrokerFeePercent >= 0
      && ownerBrokerFeePercent <= 100
    );
  const preset = skillPresets.find((item) => item.value === skillProfile);
  const skillsAvailable =
    preset !== undefined
    || (
      selectedCharacter?.skills?.hasBody === true
      && Array.isArray(selectedCharacter.skills.body)
    );
  const accounting =
    preset?.level
    ?? selectedCharacter?.skills?.body?.find((skill) => skill.skillId === accountingSkillId)
      ?.activeSkillLevel
    ?? 0;
  const brokerRelations =
    preset?.level
    ?? selectedCharacter?.skills?.body?.find((skill) => skill.skillId === brokerRelationsSkillId)
      ?.activeSkillLevel
    ?? 0;
  const profile = { accounting, brokerRelations, factionStanding, corporationStanding };
  const rates = validStandings && skillsAvailable ? tradingFeeRates(profile) : null;
  const currentQuote =
    quote?.typeId === selectedType?.typeId && quote?.marketId === marketId ? quote : null;
  const result =
    currentQuote && validQuantity && validStandings && skillsAvailable && validOwnerBrokerFee
      ? calculateMarketTaxes(
          currentQuote,
          quantity,
          profile,
          {
            playerOwnedStructure: createBuyOrdersInPlayerStructure,
            ownerBrokerFeePercent,
          },
        )
      : null;
  const usesGlobalPlexMarket = selectedType?.typeId === globalPlexMarket.typeId;
  const marketName = usesGlobalPlexMarket ? globalPlexMarket.name : selectedHub?.name;
  const skillItems = [
    ...skillPresets,
    ...(session?.characters ?? []).map((character) => ({
      value: `character:${character.characterId}`,
      label: character.characterName,
    })),
  ];
  const stalePrices =
    currentQuote && (currentQuote.status === "stale" || Date.parse(currentQuote.expiresAt) <= now);
  const staleSkills =
    selectedCharacter?.skills
    && (
      selectedCharacter.skills.status === "stale"
      || selectedCharacter.skills.status === "rate_limited"
      || selectedCharacter.skills.status === "error"
      || (
        selectedCharacter.skills.expires !== undefined
        && Date.parse(selectedCharacter.skills.expires) <= now
      )
    );
  const staleStandings =
    characterStandings
    && standingsSnapshot
    && (
      standingsSnapshot.status === "stale"
      || standingsSnapshot.status === "rate_limited"
      || standingsSnapshot.status === "error"
      || (standingsSnapshot.expires !== undefined && Date.parse(standingsSnapshot.expires) <= now)
    );

  useEffect(() => {
    const timer = window.setInterval(
      () => {
        setNow(Date.now());
      },
      30_000,
    );
    return () => {
      window.clearInterval(timer);
      activeRequest.current?.abort();
    };
  }, []);

  /** Fetches one exact type/hub quote; subsequent quantity and fee changes never call the server. */
  async function fetchPrices() {
    if (!selectedType || isLoading) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setIsLoading(true);
    setError("");
    setQuote(null);
    try {
      const response = await fetch(
        "/api/taxes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ typeId: selectedType.typeId, marketId }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : "Could not fetch market prices.";
        throw new Error(message);
      }
      const parsed = taxPriceResponseSchema.safeParse(body);
      if (
        !parsed.success
        || parsed.data.typeId !== selectedType.typeId
        || parsed.data.marketId !== marketId
      ) {
        throw new Error("The market returned an invalid quote.");
      }
      if (controller.signal.aborted) return;
      setQuote(parsed.data);
      setNow(Date.now());
    }
    catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Could not fetch market prices.");
      }
    }
    finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-2">
        <p className="eyebrow">TOOLS / TAXES</p>
        <h1>Taxes</h1>
      </header>
      <form
        className="grid min-w-0 gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void fetchPrices();
        }}
      >
        <FieldGroup className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field className="min-w-0">
            <FieldLabel htmlFor="tax-type">Item type</FieldLabel>
            <TypeSearch
              language={language}
              onSelect={(item) => {
                setSelectedType(item);
                setError("");
              }}
              inputId="tax-type"
              placeholder="Search item types..."
              ariaLabel="Item type"
              disabled={isLoading}
            />
          </Field>
          <Field className="min-w-0">
            <FieldLabel htmlFor="tax-market">Market</FieldLabel>
            <Select
              disabled={isLoading || usesGlobalPlexMarket}
              value={marketId}
              items={marketHubs.map((hub) => ({ value: hub.id, label: hub.name }))}
              onValueChange={(value) => {
                const hub = marketHubs.find((item) => item.id === value);
                if (hub) {
                  setMarketId(hub.id);
                  setError("");
                }
              }}
            >
              <SelectTrigger id="tax-market" aria-label="Market" className="w-full">
                <SelectValue>
                  {usesGlobalPlexMarket ? globalPlexMarket.name : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {marketHubs.map((hub) => (
                    <SelectItem key={hub.id} value={hub.id}>
                      {hub.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-0">
            <FieldLabel htmlFor="tax-character">CHARACTER / SKILLS</FieldLabel>
            <Select
              value={skillProfile}
              items={skillItems}
              onValueChange={(value, eventDetails) => {
                if (value && eventDetails.reason !== "none") setSkillProfile(value);
              }}
            >
              <SelectTrigger id="tax-character" aria-label="Character skills" className="w-full">
                <SelectValue>
                  {skillItems.find((item) => item.value === skillProfile)?.label
                    ?? "Character unavailable"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {skillItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field data-invalid={!validQuantity}>
            <FieldLabel htmlFor="tax-quantity">Quantity</FieldLabel>
            <Input
              id="tax-quantity"
              type="number"
              min={1}
              max={quantityLimit}
              step={1}
              value={quantityInput}
              onChange={(event) => {
                setQuantityInput(event.target.value);
              }}
              aria-invalid={!validQuantity}
              aria-describedby={!validQuantity ? "tax-quantity-error" : undefined}
            />
            {!validQuantity && (
              <FieldError id="tax-quantity-error">
                Enter a whole quantity from 1 to 1,000,000,000,000.
              </FieldError>
            )}
          </Field>
          <Field
            data-disabled={usesCharacter}
            data-invalid={!usesCharacter && !validFactionStanding}
          >
            <FieldLabel htmlFor="tax-faction">Unmodified faction standing</FieldLabel>
            <Input
              id="tax-faction"
              type="number"
              min={-10}
              max={10}
              step="any"
              disabled={usesCharacter}
              placeholder={usesCharacter ? "Unavailable" : undefined}
              value={factionValue}
              onChange={(event) => {
                setFactionInput(event.target.value);
              }}
              aria-invalid={!usesCharacter && !validFactionStanding}
              aria-describedby={
                !usesCharacter && !validFactionStanding
                  ? "tax-faction-description tax-faction-error"
                  : "tax-faction-description"
              }
            />
            <FieldDescription id="tax-faction-description">
              {selectedHub?.factionName}
            </FieldDescription>
            {!usesCharacter && !validFactionStanding && (
              <FieldError id="tax-faction-error">
                Faction standing must be between -10 and 10.
              </FieldError>
            )}
          </Field>
          <Field
            data-disabled={usesCharacter}
            data-invalid={!usesCharacter && !validCorporationStanding}
          >
            <FieldLabel htmlFor="tax-corporation">
              Unmodified station corporation standing
            </FieldLabel>
            <Input
              id="tax-corporation"
              type="number"
              min={-10}
              max={10}
              step="any"
              disabled={usesCharacter}
              placeholder={usesCharacter ? "Unavailable" : undefined}
              value={corporationValue}
              onChange={(event) => {
                setCorporationInput(event.target.value);
              }}
              aria-invalid={!usesCharacter && !validCorporationStanding}
              aria-describedby={
                !usesCharacter && !validCorporationStanding
                  ? "tax-corporation-description tax-corporation-error"
                  : "tax-corporation-description"
              }
            />
            <FieldDescription id="tax-corporation-description">
              {selectedHub?.corporationName}
            </FieldDescription>
            {!usesCharacter && !validCorporationStanding && (
              <FieldError id="tax-corporation-error">
                Corporation standing must be between -10 and 10.
              </FieldError>
            )}
          </Field>
        </FieldGroup>
        <FieldGroup className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field orientation="horizontal" className="min-w-0 sm:col-span-2">
            <FieldContent>
              <FieldLabel htmlFor="tax-player-structure">
                Create Buy Orders in Player Owned Structure
              </FieldLabel>
              <FieldDescription id="tax-player-structure-description">
                {percent(playerStructureSccSurchargeRate)} SCC surcharge is separate from the
                structure owner&apos;s broker fee (100 ISK minimum per order). No Broker Relations
                or NPC standing discounts.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="tax-player-structure"
              checked={createBuyOrdersInPlayerStructure}
              onCheckedChange={setCreateBuyOrdersInPlayerStructure}
              aria-describedby="tax-player-structure-description"
            />
          </Field>
          {createBuyOrdersInPlayerStructure && (
            <Field data-invalid={!validOwnerBrokerFee}>
              <FieldLabel htmlFor="tax-owner-broker-fee">Structure owner broker fee (%)</FieldLabel>
              <Input
                id="tax-owner-broker-fee"
                type="number"
                min={0}
                max={100}
                step="any"
                value={ownerBrokerFeeInput}
                onChange={(event) => {
                  setOwnerBrokerFeeInput(event.target.value);
                }}
                aria-invalid={!validOwnerBrokerFee}
                aria-describedby={
                  validOwnerBrokerFee
                    ? "tax-owner-broker-fee-description"
                    : "tax-owner-broker-fee-description tax-owner-broker-fee-error"
                }
              />
              <FieldDescription id="tax-owner-broker-fee-description">
                Excludes SCC. Minimum 100 ISK per order. Defaults to 0%; the actual owner rate may
                differ.
              </FieldDescription>
              {!validOwnerBrokerFee && (
                <FieldError id="tax-owner-broker-fee-error">
                  Structure owner broker fee must be between 0% and 100%.
                </FieldError>
              )}
            </Field>
          )}
        </FieldGroup>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {selectedType ? (
            <TypeIdentity typeId={selectedType.typeId} name={selectedType.name} />
          ) : (
            <span>No item selected</span>
          )}
          <Button
            type="submit"
            disabled={
              !selectedType
              || isLoading
              || !validQuantity
              || !validStandings
              || !validOwnerBrokerFee
            }
          >
            {isLoading ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Search data-icon="inline-start" aria-hidden="true" />
            )}
            {isLoading ? "Fetching prices..." : "Fetch Prices"}
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <span>Accounting: {skillsAvailable ? accounting : "Unavailable"}</span>
        <span>Broker Relations: {skillsAvailable ? brokerRelations : "Unavailable"}</span>
        <span>Sales tax: {rates ? percent(rates.salesTax) : "Unavailable"}</span>
        <span>
          NPC broker fee: {rates ? percent(rates.brokerFee, 2) : "Unavailable"} (100 ISK minimum per
          order)
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Sell orders use NPC station fees; buy orders use the selected fee setting. Prices remain
        from the selected market, not the player structure. Hub sell prices use orders at the
        station; buy prices include regional orders whose range covers the hub. PLEX uses its global
        market. Placed sell orders undercut and placed buy orders outbid by the nearest valid market
        tick, with four significant figures and a 0.01 ISK minimum. Immediate trades use quoted
        prices. Character standings use unmodified cached ESI values; skill presets use manual
        standings, initially neutral. Buyers pay no sales tax. Totals assume the entire quantity
        trades at the displayed unit price; market depth and relisting fees are excluded.
      </p>
      {!session && <p role="status">Loading character skills and standings...</p>}
      {session && !session.authenticated && (
        <p>Not signed in. Character skills are unavailable; skill presets remain available.</p>
      )}
      {sessionError && (
        <Alert variant="destructive">
          <AlertDescription>{sessionError}</AlertDescription>
        </Alert>
      )}
      {usesCharacter && !characterStandings && (
        <Alert>
          <AlertTitle>Character standings unavailable</AlertTitle>
          <AlertDescription>
            <p>
              {needsStandingsAuthorization
                ? "Grant standings access, then refresh character data."
                : "Refresh character data from the sidebar. Character-based totals are unavailable until standings are cached."}
            </p>
            {needsStandingsAuthorization && selectedCharacter && (
              <EveAuthorizationWarning
                href={`/api/auth/eve/start?characterId=${selectedCharacter.characterId}`}
              >
                <Button type="button" variant="outline">
                  <KeyRound data-icon="inline-start" aria-hidden="true" />
                  Authorize standings
                </Button>
              </EveAuthorizationWarning>
            )}
          </AlertDescription>
        </Alert>
      )}
      {staleStandings && (
        <Alert>
          <AlertTitle>Cached character standings</AlertTitle>
          <AlertDescription>
            Fees use the last available standings snapshot. Refresh character data from the sidebar;
            ESI failures or rate limits may delay updates.
          </AlertDescription>
        </Alert>
      )}
      {!skillsAvailable && (
        <Alert>
          <AlertTitle>Character skills unavailable</AlertTitle>
          <AlertDescription>
            Refresh character data from the sidebar or select a skill preset. Character-based totals
            are unavailable until skills are cached.
          </AlertDescription>
        </Alert>
      )}
      {staleSkills && (
        <Alert>
          <AlertTitle>Cached character skills</AlertTitle>
          <AlertDescription>
            Fees use the last available skill snapshot
            {selectedCharacter.skills?.lastUpdated
              ? ` from ${new Date(selectedCharacter.skills.lastUpdated).toLocaleString()}`
              : ""}
            . Refresh character data for current skills.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {isLoading && <p role="status">Fetching {marketName} prices...</p>}
      {currentQuote && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {stalePrices
              ? "Stale prices"
              : currentQuote.status === "cached"
                ? "Cached prices"
                : "Fresh prices"}
          </Badge>
          <span className="text-sm">
            {marketName}
            {usesGlobalPlexMarket ? "" : " hub station"} · Source time:{" "}
            {new Date(currentQuote.fetchedAt).toLocaleString()} · Expires:{" "}
            {new Date(currentQuote.expiresAt).toLocaleString()}
          </span>
        </div>
      )}
      {stalePrices && (
        <Alert>
          <AlertTitle>Prices have expired</AlertTitle>
          <AlertDescription>
            These totals use the previous quote. Fetch prices again for an updated estimate.
          </AlertDescription>
        </Alert>
      )}
      {currentQuote && (currentQuote.lowestSell === null || currentQuote.highestBuy === null) && (
        <Alert>
          <AlertTitle>Incomplete order book</AlertTitle>
          <AlertDescription>
            No active {currentQuote.lowestSell === null ? "sell" : "buy"} orders were found{" "}
            {usesGlobalPlexMarket ? "in " : currentQuote.lowestSell === null ? "at " : "covering "}
            {marketName}
            {usesGlobalPlexMarket ? "" : " hub station"}
            {currentQuote.lowestSell === null && currentQuote.highestBuy === null
              ? "; no buy orders were found covering this market either"
              : ""}
            . Affected scenarios and split prices are unavailable.
          </AlertDescription>
        </Alert>
      )}
      {result && selectedType ? (
        <>
          {currentQuote && currentQuote.lowestSell !== null && currentQuote.lowestSell <= 0.01 && (
            <Alert>
              <AlertTitle>Sell quote is already at the minimum price</AlertTitle>
              <AlertDescription>
                No valid sell price undercuts 0.01 ISK. The placed sell-order scenario and Using
                Orders split are unavailable. Immediate trades still use quoted prices; the
                before-fee midpoint requires both buy and sell quotes.
              </AlertDescription>
            </Alert>
          )}
          <section aria-labelledby="tax-selling" className="grid min-w-0 gap-3">
            <h2 id="tax-selling" className="wrap-break-word">
              Selling {selectedType.name}
            </h2>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <ScenarioCard
                title="Place sell order"
                priceLabel="Sell order / unit"
                result={result.sellOrder}
                selling
                brokerRate={result.rates.brokerFee}
                salesTaxRate={result.rates.salesTax}
              />
              <ScenarioCard
                title="Sell immediately to buy order"
                priceLabel="Highest buy / unit"
                result={result.instantSell}
                selling
                brokerRate={0}
                salesTaxRate={result.rates.salesTax}
              />
            </div>
          </section>
          <section aria-labelledby="tax-buying" className="grid min-w-0 gap-3">
            <h2 id="tax-buying" className="wrap-break-word">
              Buying {selectedType.name}
            </h2>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <ScenarioCard
                title="Buy immediately from sell order"
                priceLabel="Lowest sell / unit"
                result={result.instantBuy}
                selling={false}
                brokerRate={0}
                salesTaxRate={0}
              />
              <ScenarioCard
                title="Place buy order"
                priceLabel="Buy order / unit"
                result={result.buyOrder}
                selling={false}
                brokerRate={result.buyOrderBrokerRate}
                salesTaxRate={0}
                sccSurchargeRate={
                  createBuyOrdersInPlayerStructure ? result.buyOrderSccSurchargeRate : undefined
                }
              />
            </div>
          </section>
          <section aria-labelledby="tax-split" className="grid min-w-0 gap-3">
            <h2 id="tax-split">Split price</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Scenario</TableHead>
                  <TableHead scope="col" className="text-right tabular-nums">
                    Unit
                  </TableHead>
                  {quantity !== 1 && (
                    <TableHead scope="col" className="text-right tabular-nums">
                      {quantity.toLocaleString()} units
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableHead scope="row">Before fees</TableHead>
                  <TableCell className="text-right tabular-nums">
                    {isk(result.splitUnitPrice, 0, 0)}
                  </TableCell>
                  {quantity !== 1 && (
                    <TableCell className="text-right tabular-nums">
                      {isk(result.splitBeforeFees, 0, 0)}
                    </TableCell>
                  )}
                </TableRow>
                <TableRow>
                  <TableHead scope="row">After fees</TableHead>
                  <TableCell className="text-right tabular-nums">
                    {isk(
                      result.splitAfterFees === null ? null : result.splitAfterFees / quantity,
                      0,
                      0,
                    )}
                  </TableCell>
                  {quantity !== 1 && (
                    <TableCell className="text-right tabular-nums">
                      {isk(result.splitAfterFees, 0, 0)}
                    </TableCell>
                  )}
                </TableRow>
                <TableRow>
                  <TableHead scope="row">Using Orders</TableHead>
                  <TableCell className="text-right tabular-nums">
                    {isk(
                      result.splitUsingOrders === null ? null : result.splitUsingOrders / quantity,
                      0,
                      0,
                    )}
                  </TableCell>
                  {quantity !== 1 && (
                    <TableCell className="text-right tabular-nums">
                      {isk(result.splitUsingOrders, 0, 0)}
                    </TableCell>
                  )}
                </TableRow>
                <TableRow>
                  <TableHead scope="row">Immediate</TableHead>
                  <TableCell className="text-right tabular-nums">
                    {isk(
                      result.splitImmediate === null ? null : result.splitImmediate / quantity,
                      0,
                      0,
                    )}
                  </TableCell>
                  {quantity !== 1 && (
                    <TableCell className="text-right tabular-nums">
                      {isk(result.splitImmediate, 0, 0)}
                    </TableCell>
                  )}
                </TableRow>
              </TableBody>
            </Table>
          </section>
        </>
      ) : (
        !isLoading
        && !currentQuote
        && !error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No prices fetched</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )
      )}
    </div>
  );
}
