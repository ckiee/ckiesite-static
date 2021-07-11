// Now unused.
async function getFronters() {
  return await (await fetch("https://api.pluralkit.me/v1/s/giwsu/fronters")).json();
}

(async () => {
    const { members } = await getFronters();
    const fronterEle = document.querySelector("#fronter");
    const fronterInnerEle = document.querySelector("#fronter code");
    fronterInnerEle.innerText = members[0].name;
    fronterEle.classList.remove("hidden");
})();
