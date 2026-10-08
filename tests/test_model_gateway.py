import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from webapp.model_gateway import (
    POSITIVE_LEVELS,
    GatewayError,
    ModelGateway,
    gateway_agent_metadata,
    gateway_efforts,
    normalize_gateway_models,
    resolve_gateway_selection,
)


def model(name, profile="openai", **caps):
    return {
        "id": name,
        "owned_by": name.split("/")[0],
        "capabilities": {"reasoning": True, "thinkingFormat": profile, **caps},
    }


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.models = normalize_gateway_models(
            [
                model("cx/gpt-6.1-sol"),
                model("cx/gpt-5.5"),
                model("cmc/deepseek/deepseek-v4-pro", "commandcode"),
                model("cmc/xiaomi/mimo-v2.5-pro", "commandcode"),
                model("ag/claude-sonnet-4-6", "claude-adaptive"),
                model("ag/gemini-3.8-flash", "gemini-level"),
                model("ag/gemini-3-flash", "gemini-level"),
                model("ag/gemini-3.1-pro-low", "gemini-level"),
                model("Unknown/Case/Multi-Slash[1m]", "new-profile"),
            ]
        )

    def resolve(self, entry, settings=None, native=POSITIVE_LEVELS):
        return resolve_gateway_selection(
            entry, models=self.models, settings=settings or {}, native_levels=native
        )

    def levels(self, name, native=POSITIVE_LEVELS):
        return gateway_efforts(
            next(row for row in self.models if row["id"] == name), "codex", native
        )

    def test_opaque_id_round_trip_and_no_aliases(self):
        name = "Unknown/Case/Multi-Slash[1m]"
        self.assertEqual(
            self.resolve({"agent": "claude", "model": name, "effort": ""}),
            {"agent": "claude", "model": name, "effort": ""},
        )
        for invalid in (
            name.lower(),
            "deepseek-v4-pro",
            "cx/gpt-6.1-sol (high)",
            "",
            "missing",
        ):
            with (
                self.subTest(invalid=invalid),
                self.assertRaisesRegex(GatewayError, "is unavailable in 9router"),
            ):
                self.resolve({"agent": "codex", "model": invalid})

    def test_model_specific_positive_levels(self):
        self.assertEqual(self.levels("cx/gpt-6.1-sol"), POSITIVE_LEVELS)
        self.assertEqual(self.levels("cmc/deepseek/deepseek-v4-pro"), POSITIVE_LEVELS)
        for name in ("cx/gpt-5.5", "cmc/xiaomi/mimo-v2.5-pro"):
            self.assertEqual(self.levels(name), POSITIVE_LEVELS[:-1])
            with self.assertRaisesRegex(GatewayError, "Unsupported effort 'max'"):
                self.resolve({"agent": "codex", "model": name, "effort": "max"})
        self.assertEqual(self.levels("ag/gemini-3-flash"), ("low", "medium", "high"))
        self.assertEqual(self.levels("ag/gemini-3.1-pro-low"), ("low", "high"))

    def test_managed_and_native_intersection(self):
        for name in (
            "ag/claude-sonnet-4-6",
            "ag/gemini-3.8-flash",
            "Unknown/Case/Multi-Slash[1m]",
        ):
            self.assertEqual(self.levels(name), ())
            with self.assertRaises(GatewayError):
                self.resolve({"agent": "claude", "model": name, "effort": "high"})
        self.assertEqual(
            self.levels("cx/gpt-6.1-sol", ("low", "high")), ("low", "high")
        )

    def test_missing_effort_differs_from_explicit_blank(self):
        settings = {"agent_efforts": {"codex": "high"}}
        entry = {"agent": "codex", "model": "cx/gpt-6.1-sol"}
        self.assertEqual(self.resolve(entry, settings)["effort"], "high")
        self.assertEqual(self.resolve({**entry, "effort": ""}, settings)["effort"], "")
        self.assertEqual(self.resolve(entry)["effort"], "medium")
        for invalid in ("auto", "ultra", "none", "HIGH", None):
            with self.subTest(invalid=invalid), self.assertRaises(GatewayError):
                self.resolve({**entry, "effort": invalid})

    def test_defaults_do_not_remap_persisted_runs_or_mix_rows(self):
        settings = {
            "agent_models": {
                "codex": "removed",
                "claude": "Unknown/Case/Multi-Slash[1m]",
            },
            "agent_efforts": {"codex": "high", "claude": ""},
        }
        self.assertEqual(
            self.resolve({"agent": "codex"}, settings)["model"], "cx/gpt-6.1-sol"
        )
        self.assertEqual(
            self.resolve({"agent": "claude"}, settings)["model"],
            "Unknown/Case/Multi-Slash[1m]",
        )
        with self.assertRaises(GatewayError):
            self.resolve(
                {"agent": "codex", "model": "removed", "effort": "high"}, settings
            )
        rows = [
            self.resolve(
                {"agent": "codex", "model": "cx/gpt-6.1-sol", "effort": "high"}
            ),
            self.resolve(
                {
                    "agent": "codex",
                    "model": "cmc/deepseek/deepseek-v4-pro",
                    "effort": "low",
                }
            ),
        ]
        self.assertEqual([row["effort"] for row in rows], ["high", "low"])

    def test_metadata_and_resolver_use_same_policy(self):
        provider = SimpleNamespace(
            name="codex",
            label="Codex",
            badge_mode="model",
            effort_levels=POSITIVE_LEVELS,
        )
        metadata = gateway_agent_metadata(provider, self.models, {})
        for public in metadata["models"]:
            for effort in public["effort_levels"]:
                resolved = self.resolve(
                    {
                        "agent": "codex",
                        "model": public["value"],
                        "effort": effort["value"],
                    }
                )
                self.assertEqual(resolved["effort"], effort["value"])
        managed = next(
            row for row in metadata["models"] if row["value"] == "ag/claude-sonnet-4-6"
        )
        self.assertEqual(managed["effort_mode"], "managed")
        self.assertIn("does not forward", managed["effort_note"])

    def test_catalog_validation_and_filtering(self):
        for rows in (
            None,
            {},
            [{"id": ""}],
            [{"id": 1}],
            [model("cx/a"), model("cx/a")],
            [{"id": "a", "capabilities": []}],
        ):
            with (
                self.subTest(rows=rows),
                self.assertRaisesRegex(GatewayError, "invalid model catalog"),
            ):
                normalize_gateway_models(rows)
        self.assertEqual(normalize_gateway_models([]), [])
        self.assertEqual(
            normalize_gateway_models([model("image", tools=False), {"id": "opaque"}]),
            [
                {
                    "id": "opaque",
                    "owned_by": "",
                    "capabilities": {},
                    "context_length": None,
                }
            ],
        )


class CatalogTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "agent-env-auth.json"
        self.path.write_text(
            json.dumps(
                {
                    "claude": {"legacy": "retained"},
                    "9router": {
                        "api_key": "private-test-token",
                        "base_url": "http://gateway.test/v1",
                    },
                }
            )
        )
        self.gateway = ModelGateway(self.path)

    def client(self, handler):
        transport = httpx.MockTransport(handler)
        factory = httpx.AsyncClient
        return patch(
            "webapp.model_gateway.httpx.AsyncClient",
            side_effect=lambda **kwargs: factory(transport=transport, **kwargs),
        )

    async def test_refresh_failure_blocks_stale_catalog_and_public_secret(self):
        with self.client(
            lambda request: httpx.Response(
                200, json={"data": [model("cx/gpt-6.1-sol")]}
            )
        ):
            self.assertEqual((await self.gateway.catalog())[0]["id"], "cx/gpt-6.1-sol")
            status = await self.gateway.public_status()
        self.assertNotIn("private-test-token", json.dumps(status))
        self.assertNotIn("private-test-token", repr(self.gateway.load_config()))
        with self.client(
            lambda request: httpx.Response(
                401, json={"error": "private upstream details"}
            )
        ):
            with self.assertRaisesRegex(
                GatewayError, "9router authentication failed"
            ) as caught:
                await self.gateway.catalog(force_refresh=True)
            self.assertEqual(caught.exception.status_code, 503)
            with self.assertRaises(GatewayError):
                await self.gateway.catalog()

    async def test_malformed_empty_and_network_errors(self):
        for payload in ({"data": {}}, {}, {"data": [{"id": ""}]}, ["wrong"]):
            with (
                self.client(
                    lambda request, payload=payload: httpx.Response(200, json=payload)
                ),
                self.assertRaisesRegex(GatewayError, "invalid model catalog"),
            ):
                await self.gateway.catalog(force_refresh=True)
        with self.client(lambda request: httpx.Response(200, json={"data": []})):
            status = await self.gateway.public_status(force_refresh=True)
            self.assertEqual(status["status"], "empty")
            self.assertFalse(status["harnesses"]["claude"]["ready"])

        def timeout(request):
            raise httpx.ReadTimeout("private detail", request=request)

        with (
            self.client(timeout),
            self.assertRaisesRegex(GatewayError, "9router catalog unavailable"),
        ):
            await self.gateway.catalog(force_refresh=True)

    async def test_bad_url_is_repairable_and_legacy_credentials_retained(self):
        self.gateway.save_config({"base_url": "invalid?endpoint", "api_key": ""})
        status = await self.gateway.public_status()
        self.assertEqual(status["status"], "error")
        self.assertEqual(status["base_url"], "invalid?endpoint")
        self.gateway.save_config({"base_url": "http://gateway.test/v1/", "api_key": ""})
        self.assertEqual(self.gateway.load_config().base_url, "http://gateway.test/v1")
        self.assertEqual(
            json.loads(self.path.read_text())["claude"], {"legacy": "retained"}
        )

    async def test_auto_file_rotation_and_explicit_key_precedence(self):
        first = Path(self.temp.name) / "first-key"
        second = Path(self.temp.name) / "second-key"
        first.write_text("expired")
        second.write_text("valid")
        self.path.write_text(
            json.dumps({"9router": {"base_url": "http://gateway.test/v1"}})
        )

        def response(request):
            return (
                httpx.Response(200, json={"data": [model("cx/gpt-6.1-sol")]})
                if request.headers["Authorization"] == "Bearer valid"
                else httpx.Response(401)
            )

        with (
            patch.dict("os.environ", {"NINEROUTER_API_KEY": ""}),
            patch("webapp.model_gateway._key_candidates", return_value=[first, second]),
            self.client(response),
        ):
            await self.gateway.catalog()
            self.assertEqual(
                json.loads(self.path.read_text())["9router"]["key_file"], str(second)
            )
            second.write_text("rotated")
            first.write_text("valid")
            await self.gateway.catalog(force_refresh=True)
            self.assertEqual(
                json.loads(self.path.read_text())["9router"]["key_file"], str(first)
            )
            self.gateway.save_config(
                {"api_key": "wrong", "base_url": "http://gateway.test/v1"}
            )
            with self.assertRaisesRegex(GatewayError, "authentication failed"):
                await self.gateway.catalog(force_refresh=True)
        self.path.write_text(
            json.dumps({"9router": {"base_url": "http://gateway.test/v1"}})
        )
        with (
            patch.dict("os.environ", {"NINEROUTER_API_KEY": "wrong"}),
            patch("webapp.model_gateway._key_candidates", return_value=[first]),
            self.client(response),
            self.assertRaisesRegex(GatewayError, "authentication failed"),
        ):
            await self.gateway.catalog(force_refresh=True)

    async def test_configuration_update_cannot_publish_old_catalog(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def response(request):
            if request.url.host == "gateway.test":
                entered.set()
                await release.wait()
                return httpx.Response(200, json={"data": [model("cx/gpt-6.1-sol")]})
            return httpx.Response(401)

        with self.client(response):
            refresh = asyncio.create_task(self.gateway.catalog())
            await entered.wait()
            update = asyncio.create_task(
                self.gateway.configure(
                    {"base_url": "http://changed.test/v1", "api_key": ""}
                )
            )
            release.set()
            await asyncio.gather(refresh, update)
            with self.assertRaisesRegex(GatewayError, "authentication failed"):
                await self.gateway.catalog()


if __name__ == "__main__":
    unittest.main()
