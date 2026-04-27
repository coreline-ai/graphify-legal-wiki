import { describe, expect, it } from 'vitest';
import { apiErrorMessageFromPayload } from './client';

describe('apiErrorMessageFromPayload', () => {
  it('formats FastAPI validation detail arrays without [object Object]', () => {
    const message = apiErrorMessageFromPayload(
      {
        detail: [
          {
            type: 'string_too_short',
            loc: ['body', 'question'],
            msg: 'String should have at least 1 character',
            input: '',
          },
        ],
      },
      'Unprocessable Entity',
    );

    expect(message).toBe('body.question: String should have at least 1 character');
    expect(message).not.toContain('[object Object]');
  });

  it('falls back to JSON for arbitrary object errors', () => {
    const message = apiErrorMessageFromPayload(
      { detail: { code: 'GRAPH_BAD_PARAM', value: { graph: 'bad' } } },
      'Bad Request',
    );

    expect(message).toContain('GRAPH_BAD_PARAM');
    expect(message).not.toContain('[object Object]');
  });
});
