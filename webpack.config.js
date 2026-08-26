const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: 'development',
  entry: './src/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/index.html',
    }),
  ],
  devServer: {
    // 模板库以静态资源方式暴露，供前端 fetch(/templates/<名>.docx) 取源填充与下载。
    // watch: false 是关键：否则上传模板会触发 live-reload，打断上传反馈与预览。
    static: [
      {
        directory: path.join(__dirname, 'templates'),
        publicPath: '/templates',
        watch: false,
      },
    ],
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 5173,
    open: false,
    hot: true,
    allowedHosts: 'all',
    setupMiddlewares(middlewares, devServer) {
      // 挂载模板/配置 API（devServer.app 即 express 实例）
      require('./server/templateApi')(devServer.app);
      return middlewares;
    },
  },
};