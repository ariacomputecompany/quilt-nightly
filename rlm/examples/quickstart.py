import os

from rlm import RLM
from rlm.logger import RLMLogger


def main() -> None:
    logger = RLMLogger(log_dir="/workspace/.quilt/rlm/trajectories")
    rlm = RLM(
        backend="openai",
        backend_kwargs={
            "api_key": os.getenv("OPENAI_API_KEY"),
            "model_name": os.getenv("OPENAI_MODEL", "gpt-5-mini"),
        },
        logger=logger,
        verbose=True,
    )
    result = rlm.completion("Compute the first 10 powers of two and explain the pattern.")
    print(result.response)


if __name__ == "__main__":
    main()
