import { createContext } from "react";
import type { ConnectionStatus } from "../../hooks/useInertiaConnection";

export const HtmlRenderRuntimeStatusContext = createContext<ConnectionStatus>("online");
