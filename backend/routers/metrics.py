"""전송량 계측 결과. 무엇을 세는지는 backend/metrics.py 에 있다."""
from fastapi import APIRouter

import metrics

router = APIRouter()


@router.get('')
def stats():
    return metrics.snapshot()


@router.get('/hours')
def stats_hours(since: str | None = None):
    """다 지난 시간 구간의 원자료. bb26-backup 의 collect 가 매시 since=마지막으로 받은 시간 으로 부른다."""
    return metrics.hours_since(since)
