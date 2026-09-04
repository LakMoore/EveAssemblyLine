"use client";

import Link from "next/link";
import {
  cloneElement,
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEventHandler,
  type ReactElement,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type EveAuthorizationWarningProps = {
  href: string;
  children: ReactElement<{ onClick?: MouseEventHandler }>;
};

export const acknowledgementStorageKey = "assembly-line-eve-authorization-warning-acknowledged";
const acknowledgementChangedEvent = "assembly-line-eve-authorization-warning-changed";

function subscribeToAcknowledgement() {
  const notify = () => undefined;
  window.addEventListener("storage", notify);
  window.addEventListener(acknowledgementChangedEvent, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(acknowledgementChangedEvent, notify);
  };
}

function getAcknowledgementSnapshot() {
  return window.localStorage.getItem(acknowledgementStorageKey) === "true";
}

function getServerAcknowledgementSnapshot() {
  return false;
}

export function setEveAuthorizationAcknowledgement(acknowledged: boolean) {
  if (acknowledged) {
    window.localStorage.setItem(acknowledgementStorageKey, "true");
  }
  else {
    window.localStorage.removeItem(acknowledgementStorageKey);
  }
  window.dispatchEvent(new CustomEvent(acknowledgementChangedEvent, { detail: acknowledged }));
}

/**
 * Requires confirmation before starting the EVE SSO authorization flow.
 *
 * @param props The SSO destination and the element that opens the warning.
 * @returns The warning trigger and its confirmation dialog.
 */
export default function EveAuthorizationWarning({ href, children }: EveAuthorizationWarningProps) {
  const localAcknowledgement = useSyncExternalStore(
    subscribeToAcknowledgement,
    getAcknowledgementSnapshot,
    getServerAcknowledgementSnapshot,
  );
  const [hasServerAcknowledgement, setHasServerAcknowledgement] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isSavingAcknowledgement, setIsSavingAcknowledgement] = useState(false);
  const isAcknowledged = localAcknowledgement || hasServerAcknowledgement;

  useEffect(() => {
    void fetch("/api/auth/session/authorization-warning")
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { acknowledgedAt?: string | null };
        if (!data.acknowledgedAt) return;
        setEveAuthorizationAcknowledgement(true);
        setHasServerAcknowledgement(true);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    function handleAcknowledgementChange(event: Event) {
      setHasServerAcknowledgement((event as CustomEvent<boolean>).detail);
    }
    window.addEventListener(acknowledgementChangedEvent, handleAcknowledgementChange);
    return () =>
      window.removeEventListener(acknowledgementChangedEvent, handleAcknowledgementChange);
  }, []);

  function acknowledgeWarning() {
    setEveAuthorizationAcknowledgement(true);
    setHasServerAcknowledgement(true);
    setIsSavingAcknowledgement(true);
    void fetch("/api/auth/session/authorization-warning", { method: "POST" })
      .catch(() => undefined)
      .finally(() => setIsSavingAcknowledgement(false));
  }

  const directTrigger = cloneElement(
    children,
    {
      onClick: (event) => {
        children.props.onClick?.(event);
        if (!event.defaultPrevented) window.location.assign(href);
      },
    },
  );

  return (
    <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
      {isAcknowledged ? directTrigger : <AlertDialogTrigger render={children} />}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Before you continue to EVE SSO</AlertDialogTitle>
          <AlertDialogDescription>
            If it can be seen in game, it can be seen in AssemblyLine.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 text-left sm:text-sm">
          <p>
            By authorising a corporation Director via EVE SSO, you give AssemblyLine permission to
            refresh its cache of corporation assets at any time. Asset data may be served to other
            corporation members from that cache but only if those members have &quot;Take&quot; or
            &quot;Query&quot; permissions on Corporation Hangars in-game.
          </p>
          <p>
            Learn more on our <Link href="/privacy">privacy page.</Link>
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              onChange={(event) => {
                if (event.currentTarget.checked) acknowledgeWarning();
              }}
            />
            <span>I understand. Do not show me this again.</span>
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isSavingAcknowledgement}
            onClick={() => window.location.assign(href)}
          >
            Continue to EVE SSO
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
