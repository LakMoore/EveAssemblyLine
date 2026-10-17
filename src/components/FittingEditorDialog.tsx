"use client";

import { useEffect, useId, useState, type SubmitEvent } from "react";
import { Copy, Save, X } from "lucide-react";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import FittingContents from "@/components/FittingContents";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { importFittingText } from "@/lib/fittings/import";
import type { FittingInput, SavedFitting } from "@/lib/fittings/model";
import { fetchTypeMetadata } from "@/lib/reference/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import { fittingDisplayItems } from "@/lib/fittings/display";
import { serializeEftFitting } from "@/lib/fittings/export";

/** Read-only fitting view or new fitting input, with creation owned by the collection page. */
type FittingDialogProps = {
  initial?: SavedFitting;
  stale?: boolean;
  language: SdeLanguage;
  onClose: () => void;
  onSave: (input: FittingInput) => Promise<void>;
};

/** Views immutable fittings and retains new-fitting drafts on server/validation failures. */
export default function FittingDialog({
  initial,
  stale,
  language,
  onClose,
  onSave,
}: FittingDialogProps) {
  const formId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notesEdited, setNotesEdited] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [ammunitionTypeIds, setAmmunitionTypeIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!initial) return;
    let active = true;
    void fetchTypeMetadata(
      [initial.shipTypeId, ...initial.items.map((item) => item.type_id)],
      language,
    )
      .then((items) => {
        if (!active) return;
        setNames(new Map(items.map((item) => [item.typeId, item.name])));
        setAmmunitionTypeIds(
          new Set(items.filter((item) => item.isAmmo).map((item) => item.typeId)),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [initial, language]);

  /** Resolves pasted text before creating a new fitting using numeric identities only. */
  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (initial) return;
    setBusy(true);
    setError("");
    try {
      if (!text.trim()) throw new Error("Paste a fitting first.");
      const fitting = await importFittingText(text, language);
      await onSave({
        name: name.trim() || fitting.name,
        description: notesEdited ? description : fitting.description,
        shipTypeId: fitting.shipTypeId,
        items: fitting.items,
      });
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this fitting.");
    }
    finally {
      setBusy(false);
    }
  }

  /** Copies the fitting using EFT's ship header and slot-separated text format. */
  async function copy(): Promise<void> {
    if (!initial) return;
    try {
      const metadata = await fetchTypeMetadata(
        [initial.shipTypeId, ...initial.items.map((item) => item.type_id)],
        language,
      );
      const resolvedNames = new Map(names);
      for (const item of metadata) resolvedNames.set(item.typeId, item.name);
      const resolvedAmmunitionTypeIds = new Set([
        ...ammunitionTypeIds,
        ...metadata.filter((item) => item.isAmmo).map((item) => item.typeId),
      ]);
      const fittingText = serializeEftFitting(initial, resolvedNames, resolvedAmmunitionTypeIds);
      await navigator.clipboard.writeText(fittingText);
      setCopied(true);
    }
    catch (failure) {
      setError(
        failure instanceof Error
          ? `Could not copy EFT fitting: ${failure.message}`
          : "Could not copy EFT fitting.",
      );
    }
  }

  /** Confirms dismissal before unmounting a changed fitting draft. */
  function requestClose(): void {
    if (busy) return;
    const dirty = !initial && (name.length > 0 || description.length > 0 || text.length > 0);
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  const footer = (
    <div className="flex w-full flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {confirmDiscard && (
        <Alert>
          <AlertDescription>Discard unsaved changes?</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {confirmDiscard ? (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirmDiscard(false);
              }}
            >
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </>
        ) : (
          <>
            {initial && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void copy()}>
                <Copy data-icon="inline-start" />
                {copied ? "Copied" : "Copy fitting"}
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>
              <X data-icon="inline-start" />
              {initial ? "Close" : "Cancel"}
            </Button>
            {!initial && (
              <Button type="submit" form={formId} disabled={busy || !text.trim()}>
                {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                {busy ? "Saving..." : "Save fitting"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <ResponsiveDialogDrawer
      open
      title={initial ? "View fitting" : "Add fitting"}
      headerContent={
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          {initial && (
            <TypeIdentity
              name={names.get(initial.shipTypeId) ?? `Ship ${initial.shipTypeId}`}
              typeId={initial.shipTypeId}
              linkPath={null}
              className="min-w-0 flex-1"
            />
          )}
          {initial ? (
            <h3 className="min-w-0 flex-1 wrap-break-word">{initial.name}</h3>
          ) : (
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
              <Input
                id={`${formId}-name`}
                form={formId}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                maxLength={200}
                disabled={busy}
                placeholder="Use imported fitting name"
              />
            </Field>
          )}
        </div>
      }
      onOpenChange={(open) => {
        if (!open && !busy) requestClose();
      }}
      dialogFooterContent={footer}
      drawerFooterContent={footer}
    >
      {initial ? (
        <div className="flex min-w-0 flex-col gap-5">
          {stale && (
            <Alert>
              <AlertDescription>
                Showing cached fitting contents. The server could not be verified.
              </AlertDescription>
            </Alert>
          )}
          {initial.description && (
            <section className="flex min-w-0 flex-col gap-2" aria-label="Notes">
              <h3>Notes</h3>
              <p className="wrap-break-word whitespace-pre-wrap">{initial.description}</p>
            </section>
          )}
          <FittingContents
            items={fittingDisplayItems(initial.items, ammunitionTypeIds)}
            typeNames={names}
            linkPath={null}
          />
        </div>
      ) : (
        <form
          id={formId}
          onSubmit={(event) => void submit(event)}
          className="flex min-w-0 flex-col gap-5"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${formId}-description`}>Notes</FieldLabel>
              <Textarea
                id={`${formId}-description`}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setNotesEdited(true);
                }}
                maxLength={10000}
                disabled={busy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-paste`}>Fitting (EFT, XML, DNA or JSON)</FieldLabel>
              <Textarea
                id={`${formId}-paste`}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
                maxLength={250000}
                disabled={busy}
                className="min-h-48"
                placeholder="[Rifter, Patrol]"
              />
            </Field>
          </FieldGroup>
        </form>
      )}
    </ResponsiveDialogDrawer>
  );
}
