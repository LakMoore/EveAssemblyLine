"use client";

import { FormEvent, useId, useRef, useState } from "react";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseFitting, resolveFitting, type ResolvedFitting } from "@/lib/reference/fittings";
import type { SdeLanguage } from "@/lib/reference/languages";
import { FileUp, X } from "lucide-react";

type PasteFittingDialogProps = {
  language: SdeLanguage;
  onCancel: () => void;
  onImport: (fitting: ResolvedFitting) => void;
};

/** Parses and resolves a fitting pasted from the EVE client. */
export default function PasteFittingDialog({
  language,
  onCancel,
  onImport,
}: PasteFittingDialogProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const requestId = useRef(0);
  const formId = useId();

  function cancelDialog() {
    requestId.current += 1;
    onCancel();
  }

  async function importFitting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsResolving(true);
    const currentRequestId = ++requestId.current;
    try {
      const parsed = parseFitting(text);
      const resolved = await resolveFitting(parsed, language);
      if (currentRequestId !== requestId.current) return;
      onImport(resolved);
    }
    catch (resolveError) {
      setError(
        resolveError instanceof Error ? resolveError.message : "Could not import the fitting.",
      );
    }
    finally {
      setIsResolving(false);
    }
  }

  const footer = (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={cancelDialog}>
          <X aria-hidden="true" />
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={isResolving || text.trim().length === 0}>
          <FileUp aria-hidden="true" />
          <span>{isResolving ? "Checking fitting..." : "Use fitting"}</span>
        </Button>
      </div>
    </div>
  );

  return (
    <ResponsiveDialogDrawer
      open
      onOpenChange={(open) => !open && cancelDialog()}
      title="Paste fitting"
      description="Paste an EFT fitting from the EVE client to populate this structure."
      dialogFooterContent={footer}
      drawerFooterContent={footer}
    >
      <form id={formId} onSubmit={importFitting} className="flex flex-col gap-3">
        <Textarea
          className="min-h-56"
          value={text}
          onChange={(event) => {
            requestId.current += 1;
            setText(event.target.value);
            setError("");
          }}
          placeholder="[Sotiyo, Example structure]\n..."
          aria-label="EVE fitting"
          autoFocus
        />
      </form>
    </ResponsiveDialogDrawer>
  );
}

export type { PasteFittingDialogProps };
