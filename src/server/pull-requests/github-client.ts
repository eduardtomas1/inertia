import type { PullRequestKey, PullRequestSnapshot, PullRequestStack } from "../../shared/pull-requests";
import { RuntimeRequestError } from "../runtime-errors";
import { GitHubResponseError, type GitHubRequest } from "./github-transport";
import { decodePr, snapshotForPr, decodeStack, mergeResponseSchema, branchReadSchema, branchUpdateSchema, type MergeResponse } from "./github-schemas";

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  id number title state isDraft headRefName headRefOid baseRefName baseRefOid additions deletions updatedAt author{login}
  mergeStateStatus reviewDecision maintainerCanModify headRepository{viewerPermission} repository{nameWithOwner viewerPermission}
  commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){totalCount pageInfo{hasNextPage} nodes{
    __typename ... on CheckRun{status conclusion} ... on StatusContext{state}
  }}}}}} reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved}}
}}}`;
export interface ObservedBranch { id: string; number: number; head: string }
export interface GitHubPullRequests {
  read(key: PullRequestKey): Promise<PullRequestSnapshot>;
  stack(key: PullRequestKey): Promise<PullRequestStack | null>;
  merge(key: PullRequestKey, head: string): Promise<MergeResponse>;
  mergeStatus(key: PullRequestKey, uuid: string): Promise<MergeResponse>;
  branch(key: PullRequestKey, expectedHead: string, processed: ObservedBranch[]): Promise<{ id: string; head: string; base: string; behind: number }>;
  rebase(id: string, expectedHead: string): Promise<string>;
}
export class GitHubPullRequestsClient implements GitHubPullRequests {
  constructor(private readonly request: GitHubRequest, private readonly now = () => new Date().toISOString()) {}
  private variables(key: PullRequestKey) { const [owner, name] = key.repository.split("/"); return { owner, name, number: key.number }; }
  async read(key: PullRequestKey): Promise<PullRequestSnapshot> {
    return snapshotForPr(decodePr(await this.request("POST", "graphql", { query: PR_QUERY, variables: this.variables(key) }), key), this.now());
  }
  async stack(key: PullRequestKey): Promise<PullRequestStack | null> {
    try {
      const membership = decodeStack(await this.request("GET", `repos/${key.repository}/stacks?pull_request=${key.number}`), key);
      if (!membership) return null;
      const detail = decodeStack([await this.request("GET", `repos/${key.repository}/stacks/${membership.number}`)], key);
      if (!detail || detail.number !== membership.number || detail.base !== membership.base
        || detail.layers.length !== membership.layers.length || membership.layers.some((layer, index) => {
          const next = detail.layers[index]!;
          return next.number !== layer.number || next.headBranch !== layer.headBranch;
        })) throw new RuntimeRequestError("The stack changed while loading its details. Refresh and try again.");
      return detail;
    }
    catch (error) { if (error instanceof GitHubResponseError && error.status === 404) return null; throw error; }
  }
  async merge(key: PullRequestKey, head: string): Promise<MergeResponse> {
    return mergeResponseSchema.parse(await this.request("PUT", `repos/${key.repository}/pulls/${key.number}/merge-async`, { merge_method: "merge", merge_action: "default", sha: head }));
  }
  async mergeStatus(key: PullRequestKey, uuid: string): Promise<MergeResponse> {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(uuid)) throw new RuntimeRequestError("The saved merge receipt is invalid.");
    return mergeResponseSchema.parse(await this.request("GET", `repos/${key.repository}/pulls/${key.number}/merge-async/${uuid}`));
  }
  async branch(key: PullRequestKey, expectedHead: string, processed: ObservedBranch[]) {
    const result = branchReadSchema.parse(await this.request("POST", "graphql", {
      query: `query($owner:String!,$name:String!,$number:Int!,$sha:String!,$ids:[ID!]!){
        processed:nodes(ids:$ids){... on PullRequest{headRefOid}}
        repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid baseRef{target{oid} compare(headRef:$sha){behindBy}}}}}`,
      variables: { ...this.variables(key), sha: expectedHead, ids: processed.map((branch) => branch.id) },
    })).data;
    if (result.processed.length !== processed.length || processed.some((branch, index) => result.processed[index]?.headRefOid !== branch.head)) {
      throw new RuntimeRequestError("An earlier stack layer changed while rebasing. Refresh before trying again.");
    }
    const pr = result.repository.pullRequest;
    if (pr.headRefOid !== expectedHead) throw new RuntimeRequestError("The stack head changed. Refresh before trying again.");
    return { id: pr.id, head: pr.headRefOid, base: pr.baseRef.target.oid, behind: pr.baseRef.compare.behindBy };
  }
  async rebase(id: string, expectedHead: string): Promise<string> {
    return branchUpdateSchema.parse(await this.request("POST", "graphql", {
      query: `mutation($id:ID!,$sha:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$sha,updateMethod:REBASE}){pullRequest{headRefOid}}}`,
      variables: { id, sha: expectedHead },
    })).data.updatePullRequestBranch.pullRequest.headRefOid;
  }
}
