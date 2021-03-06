// Global modules
import path from "path";
import fs from "fs";
import util from "util";

// App modules
import { defaults, jpegRegex, pngRegex, to, roundTo, getQualityInterval, clampQuality, getFinalQuality } from "./lib/utils.mjs";
import convert from "./lib/convert.mjs";
import encodeWebp from "./lib/encode-webp.mjs";
import identify from "./lib/identify.mjs";
import cleanUp from "./lib/clean-up.mjs";
import trial from "./lib/trial.mjs";

// Promisified methods
const statAsync = util.promisify(fs.stat);

async function webpRecompress (input, threshold = defaults.threshold, thresholdMultiplier = defaults.thresholdMultiplier, start = defaults.start, quiet = defaults.quiet, verbose = defaults.verbose, prior = false, priorTrials) {
  if (pngRegex.test(input)) {
    let state, data;

    // Get the size of input file
    [state, data] = await to(statAsync(input));

    if (!state) {
      return [false, "Couldn't get the size of PNG input."];
    }

    const inputSize = data.size;
    const outputWebp = path.resolve(process.cwd(), input.replace(pngRegex, ".webp"));

    if (!quiet && !prior) {
      console.log(`Input: ${input}`);
    }

    // Encode lossless WebP
    [state, data] = await to(encodeWebp(input, outputWebp, 100));

    if (!state) {
      return [false, "Couldn't encode lossless WebP from PNG input."];
    }

    // Get the size of input file
    [state, data] = await to(statAsync(outputWebp));

    const outputSize = data.size;

    if (!state) {
      return [false, "Couldn't get the size of PNG input."];
    }

    return [true, `Encoded lossless WebP from PNG input: ${roundTo((inputSize) / 1024, 2)} KB -> ${roundTo((outputSize) / 1024, 2)} KB`];
  }

  if (!jpegRegex.test(input) && !pngRegex.test(input)) {
    return [false, "Input must be a JPEG or PNG image."];
  }

  // Ensure the quality is within a reasonable range
  if (start > 100 || start < 0) {
    start = clampQuality(start);
  }

  // Make sure the SSIMULACRA threshold is OK
  if (threshold > 1 || threshold < 0) {
    return [false, "Threshold must be between 0 and 1."];
  }

  let state, data, size, score;
  let quality = +start;
  let trials = priorTrials || {};

  // Get the size of input file
  [state, data] = await to(statAsync(input));

  if (!state) {
    return [false, "Couldn't get the size of JPEG input."];
  }

  if (!quiet && !prior) {
    console.log(`Input: ${input}`);
  }

  const inputSize = data.size;

  const files = {
    refPng: path.resolve(process.cwd(), input.replace(jpegRegex, ".png")),
    outputWebp: path.resolve(process.cwd(), input.replace(jpegRegex, ".webp")),
    webpPng: path.resolve(process.cwd(), input.replace(jpegRegex, "-webp.png"))
  };

  if (!prior) {
    // Try to determine JPEG quality
    [state, quality] = await to(identify(input));

    if (!state) {
      quality = start;

      if (!quiet && verbose) {
        console.log(`Couldn't guess JPEG quality. Starting at q${quality}`);
      }
    } else {
      if (!quiet && verbose) {
        console.log(`Guessed JPEG quality at q${quality}`);
      }
    }
  }

  // Create PNG reference from provided JPEG
  [state, data] = await to(convert(input, files.refPng));

  // Couldn't create a PNG reference from the given JPEG, so that's a bust :(
  if (!state) {
    return [false, `Couldn't create a PNG reference from the JPEG given: ${data}`];
  }

  if (!quiet && verbose) {
    console.log(`Trying for threshold: ${threshold}...`);
  }

  do {
    [state, data, score, size] = await trial(input, inputSize, files, quality, quiet, trials);

    if (!state) {
      return [false, `Couldn't run image trial: ${data}`];
    }

    // Record the attempt
    if (!(quality in trials)) {
      trials[quality] = {
        score,
        size,
        attempts: 0
      };
    }

    trials[quality].attempts++;

    // Sometimes we'll get in a situation where the program gets into an
    // infinite loop. I have no other strategy at the moment for solving that
    // problem except for this little diddy below.
    if (trials[quality].attempts > 3) {
      if (size >= inputSize) {
        quality -= 2;
      } else {
        quality += 2;
      }

      break;
    }

    const interval = getQualityInterval(score, threshold, quality);

    if (size >= inputSize) {
      quality -= interval;

      continue;
    }

    if (score <= threshold) {
      break;
    }

    quality += interval;
    quality = clampQuality(quality);
  } while (score > threshold || size >= inputSize);

  if (score <= threshold && size < inputSize) {
    [quality, size] = getFinalQuality(score, trials);

    await trial(input, inputSize, files, quality, true, {});
    await cleanUp(files);

    return [true, `Candidate found at q${quality}: ${roundTo((inputSize) / 1024, 2)} KB -> ${roundTo((size) / 1024, 2)} KB`];
  }

  // Try again after multiplying the threshold by the given multiplier
  return await webpRecompress(input, roundTo(threshold * thresholdMultiplier), thresholdMultiplier, quality, quiet, verbose, true, trials);
}

export default webpRecompress;
