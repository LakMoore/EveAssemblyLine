"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Clipboard, Eye, Library, RefreshCw, Trash2, UserRound } from "lucide-react";
import FittingDialog from "@/components/FittingEditorDialog";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  FittingRequestError,
  fetchFittings,
  fetchFitting,
  loadCachedFittings,
  saveFitting,
  deleteFitting,
} from "@/lib/client/fittings";
import { loadClientSession } from "@/lib/client/requestCache";
import type { FittingInput, FittingSummary, SavedFitting } from "@/lib/fittings/model";
import { fetchTypeMetadata } from "@/lib/reference/types";
import { useAppLanguage } from "../AppShell";
import { eveCharacterPortraitUrl } from "@/lib/eve/imageServer";

/** Collection fitting library, with scoped IndexedDB recovery and server-confirmed mutations. */
export default function FittingsPage() {
  const { language } = useAppLanguage();
  const [scope, setScope] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [fittings, setFittings] = useState<FittingSummary[]>([]);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [characterNames, setCharacterNames] = useState<Map<number, string>>(new Map());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ initial?: SavedFitting; stale?: boolean } | null>(null);
  const [deleting, setDeleting] = useState<SavedFitting | null>(null);
  const [pending, setPending] = useState("");
  const [reload, setReload] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    let active = true;
    /** Hydrates only after authenticating the cache scope, then revalidates with the server. */
    async function load(): Promise<void> {
      setLoading(true);
      setError("");
      try {
        const session = await loadClientSession();
        if (currentRequest !== requestId.current) return;
        if (!session.authenticated || !session.snapshotScope || !session.collectionId) {
          setAuthenticated(false);
          setFittings([]);
          setScope("");
          setCollectionId("");
          setEditor(null);
          setDeleting(null);
          return;
        }
        setAuthenticated(true);
        setCharacterNames(
          new Map(
            (session.characters ?? []).map((character) => [
              character.characterId,
              character.characterName,
            ]),
          ),
        );
        setScope(session.snapshotScope);
        const cached = await loadCachedFittings(session.snapshotScope, session.collectionId);
        if (currentRequest !== requestId.current) return;
        setFittings(cached?.fittings ?? []);
        setCollectionId(session.collectionId);
        setStale(Boolean(cached));
        const data = await fetchFittings(session.snapshotScope, session.collectionId);
        if (currentRequest !== requestId.current) return;
        setCollectionId(data.collectionId);
        setFittings(data.fittings);
        setStale(false);
      }
      catch (failure) {
        if (!active) return;
        if (
          failure instanceof FittingRequestError
          && (failure.status === 401 || failure.status === 403 || failure.status === 409)
        ) {
          setAuthenticated(false);
          setFittings([]);
          setEditor(null);
          setDeleting(null);
          setCollectionId("");
        }
        setStale(true);
        setError(failure instanceof Error ? failure.message : "Could not load fittings.");
      }
      finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
      requestId.current += 1;
    };
  }, [reload]);

  const revalidate = useEffectEvent(() => {
    setReload((value) => value + 1);
  });
  useEffect(() => {
    const refresh = () => {
      revalidate();
    };
    window.addEventListener("assembly-line-esi-refreshed", refresh);
    window.addEventListener("assembly-line-auth-changed", refresh);
    return () => {
      window.removeEventListener("assembly-line-esi-refreshed", refresh);
      window.removeEventListener("assembly-line-auth-changed", refresh);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void fetchTypeMetadata(
      fittings.map((fitting) => fitting.shipTypeId),
      language,
    )
      .then((items) => {
        if (active) setNames(new Map(items.map((item) => [item.typeId, item.name])));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [fittings, language]);

  /** Fetches the full record only when the user opens or deletes a fitting. */
  async function open(fitting: FittingSummary, remove = false): Promise<void> {
    setPending(fitting.id);
    setError("");
    const currentRequest = requestId.current;
    try {
      const result = await fetchFitting(scope, collectionId, fitting.id);
      if (currentRequest !== requestId.current) return;
      if (remove && result.fitting.source) {
        throw new Error("ESI-imported fittings cannot be deleted.");
      }
      if (remove) setDeleting(result.fitting);
      else setEditor({ initial: result.fitting, stale: result.stale });
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load fitting.");
    }
    finally {
      setPending("");
    }
  }

  /** Updates the visible list only after a successful durable write. */
  async function save(input: FittingInput): Promise<void> {
    await saveFitting(scope, collectionId, input);
    setEditor(null);
    setReload((value) => value + 1);
  }

  /** Keeps confirmation open with an actionable error when deletion fails. */
  async function remove(): Promise<void> {
    if (!deleting) return;
    setPending(deleting.id);
    setError("");
    try {
      await deleteFitting(scope, deleting, collectionId);
      setDeleting(null);
      setReload((value) => value + 1);
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not delete fitting.");
    }
    finally {
      setPending("");
    }
  }

  const filtered = fittings.filter((fitting) =>
    `${fitting.name} ${names.get(fitting.shipTypeId) ?? ""} ${fitting.shipTypeId}`
      .toLocaleLowerCase(language)
      .includes(query.trim().toLocaleLowerCase(language)),
  );
  const deleteFooter = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        variant="outline"
        disabled={Boolean(pending)}
        onClick={() => {
          setDeleting(null);
        }}
      >
        Cancel
      </Button>
      <Button variant="destructive" disabled={Boolean(pending)} onClick={() => void remove()}>
        {pending ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}Delete
        fitting
      </Button>
    </div>
  );

  return (
    <div className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
        <h1 className="text-2xl font-semibold">Fittings</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{fittings.length} fittings</Badge>
          <Button
            variant="outline"
            disabled={loading || Boolean(pending)}
            onClick={() => {
              setReload((value) => value + 1);
            }}
          >
            <RefreshCw data-icon="inline-start" />
            Reload
          </Button>
          <Button
            disabled={!authenticated || !collectionId || loading}
            onClick={() => {
              setEditor({});
            }}
          >
            <Clipboard data-icon="inline-start" />
            Add fitting
          </Button>
        </div>
      </header>
      {error && !deleting && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {stale && authenticated && fittings.length > 0 && (
        <Alert>
          <AlertDescription>
            Showing cached fittings. The server could not be verified.
          </AlertDescription>
        </Alert>
      )}
      {!authenticated ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Library />
            </EmptyMedia>
            <EmptyTitle>Connect a character</EmptyTitle>
            <EmptyDescription>No authenticated collection is available.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Field className="max-w-md">
            <FieldLabel htmlFor="fitting-search">Search fittings</FieldLabel>
            <Input
              id="fitting-search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Fitting name or ship"
            />
          </Field>
          {loading && fittings.length === 0 ? (
            <div className="grid gap-3" aria-label="Loading fittings">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Library />
                </EmptyMedia>
                <EmptyTitle>{query ? "No matching fittings" : "No fittings yet"}</EmptyTitle>
                <EmptyDescription>
                  {query
                    ? "No fittings match this search."
                    : "This collection has no saved fittings."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Ship</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((fitting) => (
                  <TableRow key={fitting.id}>
                    <TableCell className="max-w-64 wrap-break-word whitespace-normal">
                      <Button
                        variant="link"
                        className="h-auto max-w-full justify-start text-left whitespace-normal"
                        disabled={Boolean(pending)}
                        onClick={() => void open(fitting)}
                      >
                        {fitting.name}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <TypeIdentity
                        name={names.get(fitting.shipTypeId) ?? `Ship ${fitting.shipTypeId}`}
                        typeId={fitting.shipTypeId}
                        linkPath={null}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar
                          role="img"
                          aria-label={
                            fitting.source
                              ? `Provided by ${characterNames.get(fitting.source.characterId) ?? `character ${fitting.source.characterId}`}`
                              : "No source character"
                          }
                          title={
                            fitting.source
                              ? (
                                  characterNames.get(fitting.source.characterId)
                                  ?? `Character ${fitting.source.characterId}`
                                )
                              : "No source character"
                          }
                        >
                          {fitting.source && (
                            <AvatarImage
                              src={eveCharacterPortraitUrl(fitting.source.characterId, 64)}
                              alt=""
                            />
                          )}
                          <AvatarFallback>
                            <UserRound className="size-4" aria-hidden="true" />
                          </AvatarFallback>
                        </Avatar>
                        <Badge variant="outline">
                          {fitting.source ? "ESI import" : "Collection"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`View ${fitting.name}`}
                                disabled={Boolean(pending)}
                                onClick={() => void open(fitting)}
                              />
                            }
                          >
                            <Eye />
                          </TooltipTrigger>
                          <TooltipContent>View fitting</TooltipContent>
                        </Tooltip>
                        {!fitting.source && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Delete ${fitting.name}`}
                                  disabled={Boolean(pending)}
                                  onClick={() => void open(fitting, true)}
                                />
                              }
                            >
                              <Trash2 />
                            </TooltipTrigger>
                            <TooltipContent>Delete fitting</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
      {editor && (
        <FittingDialog
          initial={editor.initial}
          stale={editor.stale}
          language={language}
          onClose={() => {
            setEditor(null);
          }}
          onSave={save}
        />
      )}
      {deleting && (
        <ResponsiveDialogDrawer
          open
          title="Delete fitting?"
          description={`Delete "${deleting.name}" from this collection?`}
          onOpenChange={(isOpen) => {
            if (!isOpen && !pending) setDeleting(null);
          }}
          dialogFooterContent={deleteFooter}
          drawerFooterContent={deleteFooter}
        >
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <p>This cannot be undone. ESI refresh will not restore this fitting.</p>
          )}
        </ResponsiveDialogDrawer>
      )}
    </div>
  );
}
