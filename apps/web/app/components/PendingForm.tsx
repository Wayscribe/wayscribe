"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode
} from "react";

const PendingContext = createContext(false);

/**
 * A plain form that, with JavaScript, says it has been sent.
 *
 * The pages stay unstreamed so they work without JavaScript (the Journeys page
 * says why), which means a submitted GET form shows nothing until the next page
 * has been rendered in full. This fills that wait. It never handles the
 * submission: the browser still sends the form and loads the result as a full
 * page, exactly as it does with JavaScript off, when this renders the same
 * form and an empty status line.
 *
 * The status line is always rendered, empty until needed, so a screen reader
 * already knows the live region when the message appears.
 */
export function PendingForm({
  pendingMessage,
  children,
  onSubmit,
  ...form
}: ComponentPropsWithoutRef<"form"> & { pendingMessage: string }): ReactElement {
  const [pending, setPending] = useState(false);

  // A page restored from the back-forward cache keeps its state, which would
  // leave it saying it is still loading.
  useEffect(() => {
    const reset = (event: PageTransitionEvent): void => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => {
      window.removeEventListener("pageshow", reset);
    };
  }, []);

  return (
    <PendingContext.Provider value={pending}>
      <form
        {...form}
        onSubmit={(event) => {
          onSubmit?.(event);
          if (!event.defaultPrevented) setPending(true);
        }}
      >
        {children}
      </form>
      <p className="muted pending-status" role="status">
        {pending ? pendingMessage : ""}
      </p>
    </PendingContext.Provider>
  );
}

/**
 * The submit button of a `PendingForm`, marked busy once the form is sent.
 *
 * Busy rather than disabled: a second press only starts the same GET again,
 * and a disabled button would drop out of the tab order while the page loads.
 */
export function PendingSubmit({ children }: { children: ReactNode }): ReactElement {
  const pending = useContext(PendingContext);
  return (
    <button type="submit" aria-busy={pending ? "true" : undefined}>
      {children}
    </button>
  );
}
