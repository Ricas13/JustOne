import test from "node:test";
import assert from "node:assert/strict";
import { artworkContext, artworkPng } from "../src/artwork.js";

test("sports programme artwork uses the programme context and is a valid PNG", () => {
  const lineup = [{
    id: "sport.football.01",
    kind: "sport-slot",
    name: "Football 01",
    group: "Sports | Football",
    logo: "https://resolver.example/jellyfin/artwork/channel/sport-football.png",
    programmes: [{
      title: "Scottish Premiership : Celtic vs Rangers",
      subtitle: "Football",
      categories: ["Sports", "Football"],
      icon: "https://resolver.example/jellyfin/artwork/program/football-celtic.png",
    }],
  }];
  const context = artworkContext(lineup, "football-celtic");
  assert.equal(context?.program?.title, "Scottish Premiership : Celtic vs Rangers");
  const png = artworkPng("football-celtic", "program", context);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(png.length > 1000);
});

test("generated channel artwork is a valid PNG", () => {
  const lineup = [{
    id: "sport.football.01",
    kind: "sport-slot",
    name: "Football 01",
    group: "Sports | Football",
    logo: "https://resolver.example/jellyfin/artwork/channel/sport-football.png",
    programmes: [],
  }];
  const context = artworkContext(lineup, "sport-football");
  const png = artworkPng("sport-football", "channel", context);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(png.length > 500);
});
