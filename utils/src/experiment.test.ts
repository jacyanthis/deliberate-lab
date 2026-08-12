import {Value} from '@sinclair/typebox/value';
import {createExperimentConfig, createExperimentTemplate} from './experiment';
import {ExperimentTemplateSchema} from './experiment.validation';

describe('autoAcceptTransfers', () => {
  test('is undefined unless it is set', () => {
    expect(createExperimentConfig().autoAcceptTransfers).toBeUndefined();
  });

  test('survives a rebuild of the config', () => {
    const config = createExperimentConfig([], {autoAcceptTransfers: true});
    expect(config.autoAcceptTransfers).toBe(true);
    expect(createExperimentConfig([], config).autoAcceptTransfers).toBe(true);
  });

  test('passes validation whether set or absent', () => {
    const set = createExperimentTemplate({
      experiment: createExperimentConfig([], {autoAcceptTransfers: true}),
    });
    const absent = createExperimentTemplate({
      experiment: createExperimentConfig(),
    });
    expect(Value.Check(ExperimentTemplateSchema, set)).toBe(true);
    expect(Value.Check(ExperimentTemplateSchema, absent)).toBe(true);
  });
});
