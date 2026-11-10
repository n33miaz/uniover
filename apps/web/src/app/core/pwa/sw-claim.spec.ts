import { createClaimPolicy } from './sw-claim';

describe('sw-claim: quando o worker novo toma as páginas abertas', () => {
  it('claims on the first install: the open pages have no worker yet and there is no earlier version to protect', () => {
    const policy = createClaimPolicy();
    policy.onInstall(false);
    expect(policy.shouldClaim()).toBe(true);
  });

  it('does not claim when it replaces a worker that is already active, so a page in the middle of something is left alone', () => {
    const policy = createClaimPolicy();
    policy.onInstall(true);
    expect(policy.shouldClaim()).toBe(false);
  });

  it('claims once the app asked for the swap (the app only asks after checking this tab and the others)', () => {
    const policy = createClaimPolicy();
    policy.onInstall(true);
    policy.onSkipWaitingRequest();
    expect(policy.shouldClaim()).toBe(true);
  });

  it('never claims before it is installed or asked', () => {
    expect(createClaimPolicy().shouldClaim()).toBe(false);
  });

  it('keeps each worker instance independent', () => {
    const first = createClaimPolicy();
    const second = createClaimPolicy();
    first.onInstall(false);
    second.onInstall(true);
    expect(first.shouldClaim()).toBe(true);
    expect(second.shouldClaim()).toBe(false);
  });
});
