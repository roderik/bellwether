import { describe, it, expect } from "vitest";
import { createGitHubClient } from "../../src/github/client.js";

describe("createGitHubClient", () => {
  it("returns an Octokit instance with auth configured", () => {
    const client = createGitHubClient("test-token");
    expect(client).toBeDefined();
    expect(client.rest).toBeDefined();
    expect(client.rest.pulls).toBeDefined();
    expect(client.graphql).toBeDefined();
    expect(client.paginate).toBeDefined();
  });
});
