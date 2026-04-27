import type { AnswerResponse, EvidenceItem, QueryResponse } from '../api/types';

type EvidenceCarrier = Pick<AnswerResponse, 'evidence'> | Pick<QueryResponse, 'evidence'> | null | undefined;

function evidenceFrom(result: EvidenceCarrier): EvidenceItem[] {
  return result?.evidence ?? [];
}

export function activeEvidenceFor(
  answerResult: Pick<AnswerResponse, 'evidence'> | null | undefined,
  queryResult: Pick<QueryResponse, 'evidence'> | null | undefined,
): EvidenceItem[] {
  const answerEvidence = evidenceFrom(answerResult);
  return answerEvidence.length ? answerEvidence : evidenceFrom(queryResult);
}
