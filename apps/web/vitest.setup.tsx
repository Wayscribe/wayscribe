import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

// `next/link` wants the app router context and warns without it. The components
// under test only need an anchor with the right href. `useLinkStatus` is idle
// unless a test says otherwise with `vi.mocked(useLinkStatus)`.
vi.mock("next/link", () => ({
  useLinkStatus: vi.fn(() => ({ pending: false })),
  default: ({
    href,
    children,
    prefetch: _prefetch,
    scroll: _scroll,
    replace: _replace,
    shallow: _shallow,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
    scroll?: boolean;
    replace?: boolean;
    shallow?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}));
