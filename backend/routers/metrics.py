"""전송량 계측 결과. 무엇을 세는지는 backend/metrics.py 에 있다."""
from fastapi import APIRouter

import metrics

router = APIRouter()


@router.get('')
def stats():
    return metrics.snapshot()
