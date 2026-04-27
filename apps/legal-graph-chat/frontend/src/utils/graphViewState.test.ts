import { describe, expect, it } from 'vitest';
import { shouldShowGraphSelection } from './graphViewState';

describe('graph view state', () => {
  it('keeps the selected-node overlay out of the evidence text mode', () => {
    expect(shouldShowGraphSelection('evidence', true)).toBe(false);
  });

  it('shows the selected-node overlay only on visual graph modes with a selected node', () => {
    expect(shouldShowGraphSelection('3d', true)).toBe(true);
    expect(shouldShowGraphSelection('2d', true)).toBe(true);
    expect(shouldShowGraphSelection('3d', false)).toBe(false);
  });
});
