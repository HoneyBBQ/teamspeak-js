/**
 * The value tables that restrict an input, as a compile-time rule checked by
 * `pnpm typecheck`.
 *
 * Nothing here runs: vitest collects `src/**\/*.test.ts`, and this file is not
 * one of them. Each deliberately wrong case carries `@ts-expect-error`, which
 * fails the build as soon as that case starts compiling.
 */
import { BannerMode, BindingSubsystem } from "./index.js";
import type { BindingListOptions } from "./api/server.js";
import type { ChannelSettings } from "./api/channels.js";

declare function takesChannel(settings: ChannelSettings): void;
declare function takesBindings(options: BindingListOptions): void;

takesChannel({ bannerMode: BannerMode.AdjustKeepAspect });
takesChannel({ bannerMode: 2 });
// @ts-expect-error the server refuses a banner mode outside 0-2
takesChannel({ bannerMode: 3 });

takesBindings({ subsystem: BindingSubsystem.Query });
takesBindings({ subsystem: "filetransfer" });
// @ts-expect-error the server refuses a subsystem it does not have
takesBindings({ subsystem: "bogus" });
