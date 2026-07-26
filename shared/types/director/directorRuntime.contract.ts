import type {
  DirectorArtifactRef as LegacyArtifactRef,
  DirectorRuntimeSnapshot as LegacyRuntimeSnapshot,
  DirectorRuntimeProjection as LegacyRuntimeProjection,
  DirectorDashboardView as LegacyDashboardView,
  DirectorCommandAcceptedResponse as LegacyCommandAcceptedResponse,
  DirectorWorkspaceAnalysis as LegacyWorkspaceAnalysis,
} from "../directorRuntime";
import type { DirectorArtifactRef } from "./artifacts";
import type { DirectorRuntimeSnapshot } from "./runtime";
import type { DirectorRuntimeProjection } from "./projections";
import type { DirectorDashboardView } from "./dashboard";
import type { DirectorCommandAcceptedResponse } from "./commands";
import type { DirectorWorkspaceAnalysis } from "./workspace";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;

type ArtifactContract = Assert<Equal<LegacyArtifactRef, DirectorArtifactRef>>;
type RuntimeContract = Assert<Equal<LegacyRuntimeSnapshot, DirectorRuntimeSnapshot>>;
type ProjectionContract = Assert<Equal<LegacyRuntimeProjection, DirectorRuntimeProjection>>;
type DashboardContract = Assert<Equal<LegacyDashboardView, DirectorDashboardView>>;
type CommandContract = Assert<Equal<LegacyCommandAcceptedResponse, DirectorCommandAcceptedResponse>>;
type WorkspaceContract = Assert<Equal<LegacyWorkspaceAnalysis, DirectorWorkspaceAnalysis>>;

export type DirectorRuntimeFacadeContract =
  | ArtifactContract
  | RuntimeContract
  | ProjectionContract
  | DashboardContract
  | CommandContract
  | WorkspaceContract;
