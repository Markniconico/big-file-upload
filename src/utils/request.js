export function request({
    url,
    method = "GET",
    data,
    headers = {},
    onProgress = e => e,
    requestList
}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = onProgress;

        xhr.open(method, url);
        Object.keys(headers).forEach(key =>
            xhr.setRequestHeader(key, headers[key])
        );
        xhr.send(data);
        xhr.onload = e => {
            //这里省略部分状态码的判断,有返回就是resolve
            // 将请求成功的 xhr 从列表中删除
            if (requestList) {
                const xhrIndex = requestList.findIndex(item => item === xhr);
                requestList.splice(xhrIndex, 1);
            }
            resolve({
                data: e.target.response
            });
        };
        // 暴露当前 xhr 给外部
        if (requestList) requestList.push(xhr);
    });
}