// babel-preset-expo already carries the expo-router and JSX transforms for SDK
// 52, so the only thing to add is the reanimated plugin - which must stay last
// in the list or its worklet transform runs against half-compiled output.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
    plugins: ['react-native-reanimated/plugin'],
  };
};
